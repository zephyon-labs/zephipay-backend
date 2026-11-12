-- LOCAL CANDIDATE ONLY. Deliberately outside migrations/ discovery.
-- Requires unchanged 002_identity_foundation.sql. No production grants or roles.
CREATE SCHEMA native_session_candidate;
REVOKE ALL ON SCHEMA native_session_candidate FROM PUBLIC;

CREATE TABLE native_session_candidate.bindings (
  binding_reference text PRIMARY KEY CHECK (binding_reference ~ '^binding_[0-9a-f]{32}$'),
  login_attempt_id text NOT NULL UNIQUE CHECK (login_attempt_id ~ '^attempt_[0-9a-f]{32}$'),
  environment text NOT NULL CHECK (length(environment) BETWEEN 1 AND 512 AND environment=btrim(environment)),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512 AND issuer=btrim(issuer)),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512 AND client_id=btrim(client_id)),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 512 AND audience=btrim(audience)),
  creation_key text NOT NULL UNIQUE CHECK (creation_key ~ '^[0-9a-f]{64}$'),
  challenge text NOT NULL CHECK (challenge ~ '^[0-9a-f]{64}$'),
  access_commitment text NOT NULL CHECK (access_commitment ~ '^[0-9a-f]{64}$'),
  revocation_commitment text NOT NULL CHECK (revocation_commitment ~ '^[0-9a-f]{64}$'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  attempt_expires_at_ms bigint NOT NULL CHECK (attempt_expires_at_ms BETWEEN 0 AND 9007199254740991 AND attempt_expires_at_ms>created_at_ms),
  last_observed_at_ms bigint NOT NULL CHECK (last_observed_at_ms BETWEEN 0 AND 9007199254740991 AND last_observed_at_ms>=created_at_ms),
  attempt_state text NOT NULL CHECK (attempt_state IN ('PENDING','COMPLETED','CANCELLED','EXPIRED')),
  state text NOT NULL CHECK (state IN ('PENDING','ACTIVE','CANCELLED','EXPIRED','REVOKED')),
  owner_subject text CHECK (length(owner_subject) BETWEEN 1 AND 512 AND owner_subject=btrim(owner_subject)),
  account_id uuid REFERENCES public.accounts(account_id) ON DELETE RESTRICT,
  canonical_session_id uuid UNIQUE REFERENCES public.account_sessions(session_id) ON DELETE RESTRICT,
  CONSTRAINT native_state_relationship CHECK (
    (attempt_state='COMPLETED' AND state IN ('ACTIVE','EXPIRED','REVOKED')
      AND owner_subject IS NOT NULL AND account_id IS NOT NULL AND canonical_session_id IS NOT NULL)
    OR (attempt_state IN ('PENDING','CANCELLED','EXPIRED') AND state=attempt_state
      AND owner_subject IS NULL AND account_id IS NULL AND canonical_session_id IS NULL)),
  CONSTRAINT native_attempt_expiry_observed CHECK (state<>'EXPIRED' OR attempt_state='COMPLETED' OR last_observed_at_ms>=attempt_expires_at_ms)
);

CREATE FUNCTION native_session_candidate.protect_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native binding tombstones cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING' OR NEW.attempt_state<>'PENDING' OR NEW.last_observed_at_ms<>NEW.created_at_ms THEN
      RAISE EXCEPTION 'native bindings must begin pending at creation';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.binding_reference,NEW.login_attempt_id,NEW.environment,NEW.issuer,NEW.client_id,NEW.audience,
         NEW.creation_key,NEW.challenge,NEW.access_commitment,NEW.revocation_commitment,NEW.created_at_ms,NEW.attempt_expires_at_ms)
    IS DISTINCT FROM ROW(OLD.binding_reference,OLD.login_attempt_id,OLD.environment,OLD.issuer,OLD.client_id,OLD.audience,
         OLD.creation_key,OLD.challenge,OLD.access_commitment,OLD.revocation_commitment,OLD.created_at_ms,OLD.attempt_expires_at_ms) THEN
    RAISE EXCEPTION 'native attempt identity, context, proofs and deadline are immutable';
  END IF;
  IF NEW.last_observed_at_ms<OLD.last_observed_at_ms THEN RAISE EXCEPTION 'native clock watermark cannot decrease'; END IF;
  IF OLD.state IN ('CANCELLED','EXPIRED','REVOKED') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'native terminal state cannot reactivate'; END IF;
  IF OLD.state='PENDING' AND NEW.state NOT IN ('PENDING','ACTIVE','CANCELLED','EXPIRED') THEN RAISE EXCEPTION 'invalid pending transition'; END IF;
  IF OLD.state='ACTIVE' AND NEW.state NOT IN ('ACTIVE','EXPIRED','REVOKED') THEN RAISE EXCEPTION 'invalid active transition'; END IF;
  IF OLD.attempt_state<>'PENDING' AND NEW.attempt_state<>OLD.attempt_state THEN RAISE EXCEPTION 'native attempt cannot reopen'; END IF;
  IF OLD.canonical_session_id IS NOT NULL AND ROW(NEW.owner_subject,NEW.account_id,NEW.canonical_session_id)
      IS DISTINCT FROM ROW(OLD.owner_subject,OLD.account_id,OLD.canonical_session_id) THEN
    RAISE EXCEPTION 'native canonical owner cannot change';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER native_binding_immutable BEFORE INSERT OR UPDATE OR DELETE ON native_session_candidate.bindings
  FOR EACH ROW EXECUTE FUNCTION native_session_candidate.protect_binding();

CREATE FUNCTION native_session_candidate.canonical_relationship() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  b native_session_candidate.bindings;
  s public.account_sessions;
BEGIN
  -- Read final row, not an intermediate watermark-write NEW image at deferred execution.
  SELECT * INTO STRICT b FROM native_session_candidate.bindings WHERE binding_reference=NEW.binding_reference;
  IF b.canonical_session_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT s FROM public.account_sessions WHERE session_id=b.canonical_session_id;
  IF s.account_id<>b.account_id OR NOT EXISTS (
    SELECT 1 FROM public.external_identities WHERE issuer=b.issuer AND subject=b.owner_subject AND account_id=b.account_id
  ) THEN RAISE EXCEPTION 'native canonical identity mismatch'; END IF;
  IF TG_OP='UPDATE' AND OLD.state='PENDING' AND b.state='ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM public.accounts WHERE account_id=b.account_id AND status='ACTIVE'
  ) THEN RAISE EXCEPTION 'native completion requires an active canonical account'; END IF;
  IF extract(epoch FROM s.created_at)*1000<b.created_at_ms OR extract(epoch FROM s.created_at)*1000>=b.attempt_expires_at_ms
      OR extract(epoch FROM s.created_at)*1000>b.last_observed_at_ms THEN
    RAISE EXCEPTION 'native canonical creation chronology mismatch';
  END IF;
  IF b.state='REVOKED' AND (s.revoked_at IS NULL OR extract(epoch FROM s.revoked_at)*1000>b.last_observed_at_ms) THEN
    RAISE EXCEPTION 'native revocation lacks canonical transition';
  END IF;
  IF b.state='EXPIRED' AND floor(extract(epoch FROM s.expires_at)*1000)>b.last_observed_at_ms THEN
    RAISE EXCEPTION 'native expiry has not been observed';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER native_binding_canonical_guard AFTER INSERT OR UPDATE ON native_session_candidate.bindings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION native_session_candidate.canonical_relationship();

REVOKE ALL ON ALL TABLES IN SCHEMA native_session_candidate FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA native_session_candidate FROM PUBLIC;
