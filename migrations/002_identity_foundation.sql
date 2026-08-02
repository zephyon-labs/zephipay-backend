CREATE TYPE account_status AS ENUM (
  'ACTIVE',
  'SUSPENDED',
  'DELETION_PENDING',
  'DELETED'
);

CREATE TYPE account_security_event_type AS ENUM (
  'ACCOUNT_CREATED',
  'ACCOUNT_STATUS_CHANGED',
  'EXTERNAL_IDENTITY_LINKED',
  'SESSION_CREATED',
  'SESSION_REVOKED'
);

CREATE TABLE accounts (
  account_id uuid PRIMARY KEY,
  actor_subject text NOT NULL UNIQUE,
  status account_status NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_actor_subject_canonical
    CHECK (actor_subject = 'zp:account:' || lower(account_id::text)),
  CONSTRAINT accounts_version_nonnegative CHECK (version >= 0),
  CONSTRAINT accounts_updated_after_created CHECK (updated_at >= created_at)
);

CREATE TABLE external_identities (
  identity_id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_identities_issuer_length
    CHECK (length(issuer) BETWEEN 1 AND 512 AND issuer = btrim(issuer)),
  CONSTRAINT external_identities_subject_length
    CHECK (length(subject) BETWEEN 1 AND 512 AND subject = btrim(subject)),
  CONSTRAINT external_identities_issuer_subject_unique UNIQUE (issuer, subject)
);

CREATE INDEX external_identities_account_idx
  ON external_identities (account_id, linked_at, identity_id);

CREATE TABLE account_sessions (
  session_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT account_sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT account_sessions_revocation_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX account_sessions_account_idx
  ON account_sessions (account_id, created_at DESC, session_id);

CREATE TABLE account_security_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  event_type account_security_event_type NOT NULL,
  account_version bigint NOT NULL CHECK (account_version >= 0),
  session_id uuid REFERENCES account_sessions(session_id) ON DELETE RESTRICT,
  identity_id uuid REFERENCES external_identities(identity_id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_security_events_sequence_unique
    UNIQUE (account_id, sequence_number)
);

CREATE INDEX account_security_events_account_time_idx
  ON account_security_events (account_id, occurred_at, sequence_number);

CREATE FUNCTION protect_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR
     NEW.actor_subject IS DISTINCT FROM OLD.actor_subject OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'canonical account identity is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'account mutations must increment version exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'account updated_at cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_protect_identity
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION protect_account_identity();

CREATE FUNCTION reject_identity_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER external_identities_append_only
  BEFORE UPDATE OR DELETE ON external_identities
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

CREATE TRIGGER account_security_events_append_only
  BEFORE UPDATE OR DELETE ON account_security_events
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

CREATE FUNCTION protect_account_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR
     NEW.account_id IS DISTINCT FROM OLD.account_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'account session identity is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'account session revocation is one-way';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_sessions_protect_lifecycle
  BEFORE UPDATE ON account_sessions
  FOR EACH ROW EXECUTE FUNCTION protect_account_session();

CREATE TRIGGER account_sessions_reject_delete
  BEFORE DELETE ON account_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

CREATE FUNCTION validate_account_security_artifact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM account_security_events
    WHERE account_id = NEW.account_id
      AND account_version = NEW.version
      AND event_type = 'ACCOUNT_CREATED'
  ) THEN
    RAISE EXCEPTION 'account creation requires an atomic security event';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT EXISTS (
    SELECT 1 FROM account_security_events
    WHERE account_id = NEW.account_id AND account_version = NEW.version
  ) THEN
    RAISE EXCEPTION 'account mutation requires an atomic security event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER accounts_security_artifact_guard
  AFTER INSERT OR UPDATE ON accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_account_security_artifact();

CREATE FUNCTION validate_external_identity_security_artifact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM account_security_events
    WHERE account_id = NEW.account_id
      AND identity_id = NEW.identity_id
      AND event_type = 'EXTERNAL_IDENTITY_LINKED'
  ) THEN
    RAISE EXCEPTION 'external identity link requires an atomic security event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER external_identities_security_artifact_guard
  AFTER INSERT ON external_identities
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_external_identity_security_artifact();

CREATE FUNCTION validate_account_session_security_artifact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  required_event account_security_event_type;
BEGIN
  required_event := CASE WHEN TG_OP = 'INSERT' THEN 'SESSION_CREATED'::account_security_event_type
                         ELSE 'SESSION_REVOKED'::account_security_event_type END;
  IF NOT EXISTS (
    SELECT 1 FROM account_security_events
    WHERE account_id = NEW.account_id
      AND session_id = NEW.session_id
      AND event_type = required_event
  ) THEN
    RAISE EXCEPTION 'account session mutation requires an atomic security event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER account_sessions_security_artifact_guard
  AFTER INSERT OR UPDATE ON account_sessions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_account_session_security_artifact();
