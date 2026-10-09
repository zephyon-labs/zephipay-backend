-- Server-owned web-session references and retry records; no execution authority.
CREATE TABLE economic_web_sessions (
  reference uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  account_session_id uuid NOT NULL UNIQUE REFERENCES account_sessions,
  expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE economic_web_ceremonies (
  payment_id uuid PRIMARY KEY REFERENCES payments,
  reference uuid NOT NULL REFERENCES economic_web_sessions,
  envelope_digest text NOT NULL UNIQUE REFERENCES economic_envelopes(envelope_digest),
  challenge_id uuid NOT NULL UNIQUE REFERENCES economic_confirmation_challenges,
  transaction_id uuid NOT NULL UNIQUE,
  binding_id uuid NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE economic_web_handoff_requests (
  request_id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER economic_web_sessions_immutable BEFORE UPDATE OR DELETE ON economic_web_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_web_ceremonies_immutable BEFORE UPDATE OR DELETE ON economic_web_ceremonies
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_web_handoff_requests_immutable BEFORE UPDATE OR DELETE ON economic_web_handoff_requests
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
REVOKE ALL ON economic_web_sessions,economic_web_ceremonies,economic_web_handoff_requests FROM PUBLIC;
CREATE VIEW economic_web_status AS
  SELECT w.payment_id,w.reference,w.binding_id,c.state,c.expires_at,
    EXISTS(SELECT 1 FROM economic_confirmation_sdk_transactions s WHERE s.binding_id=w.binding_id) AS sdk_started,
    EXISTS(SELECT 1 FROM economic_confirmation_sdk_callbacks s WHERE s.binding_id=w.binding_id) AS sdk_completed,
    (SELECT token_digest FROM economic_confirmation_sdk_callbacks s WHERE s.binding_id=w.binding_id) AS sdk_token_digest
  FROM economic_web_ceremonies w JOIN economic_confirmation_summary c USING(challenge_id);
REVOKE ALL ON economic_web_status FROM PUBLIC;
CREATE FUNCTION economic_web_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='economic_web_sessions' THEN
    IF NOT EXISTS(SELECT 1 FROM account_sessions s JOIN external_identities e USING(account_id)
      WHERE s.session_id=NEW.account_session_id AND e.issuer=NEW.issuer AND e.subject=NEW.subject
      AND s.revoked_at IS NULL AND s.expires_at=NEW.expires_at AND s.expires_at>clock_timestamp())
      THEN RAISE EXCEPTION 'web session ownership mismatch'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM economic_web_sessions s JOIN economic_payment_preparations p USING(account_session_id)
      JOIN economic_confirmation_challenges c USING(account_session_id,envelope_digest)
      WHERE s.reference=NEW.reference AND p.payment_id=NEW.payment_id AND p.envelope_digest=NEW.envelope_digest
      AND c.challenge_id=NEW.challenge_id AND c.transaction_id=NEW.transaction_id)
      THEN RAISE EXCEPTION 'web ceremony binding mismatch'; END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION economic_web_binding_guard() FROM PUBLIC;
CREATE TRIGGER economic_web_session_binding BEFORE INSERT ON economic_web_sessions
  FOR EACH ROW EXECUTE FUNCTION economic_web_binding_guard();
CREATE TRIGGER economic_web_ceremony_binding BEFORE INSERT ON economic_web_ceremonies
  FOR EACH ROW EXECUTE FUNCTION economic_web_binding_guard();
-- Logout can arrive before an in-flight first preparation. Retain its tombstone even
-- when no canonical session exists yet; a delayed signed request cannot recreate it.
CREATE TABLE economic_web_revocations (
  reference uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER economic_web_revocations_immutable BEFORE UPDATE OR DELETE ON economic_web_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
REVOKE ALL ON economic_web_revocations FROM PUBLIC;
