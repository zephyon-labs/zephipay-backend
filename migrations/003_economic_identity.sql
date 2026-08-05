CREATE TYPE economic_account_type AS ENUM ('PERSONAL', 'CREATOR', 'BUSINESS', 'AI_AGENT');
CREATE TYPE identity_discoverability AS ENUM ('PRIVATE', 'USERNAME_ONLY', 'PUBLIC');
CREATE TYPE identity_verification_state AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'RESTRICTED');
CREATE TYPE identity_payability_state AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'RESTRICTED');
CREATE TYPE public_identity_status AS ENUM ('ACTIVE', 'HIDDEN');
CREATE TYPE payment_destination_type AS ENUM ('SOLANA_WALLET');
CREATE TYPE payment_destination_status AS ENUM ('ACTIVE', 'INACTIVE', 'RESTRICTED');
CREATE TYPE destination_ownership_state AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

CREATE TABLE economic_identities (
  account_id uuid PRIMARY KEY REFERENCES accounts(account_id) ON DELETE RESTRICT,
  account_type economic_account_type NOT NULL DEFAULT 'PERSONAL',
  username text NOT NULL,
  normalized_username text NOT NULL,
  display_name text NOT NULL,
  avatar_url text,
  public_identity_status public_identity_status NOT NULL DEFAULT 'ACTIVE',
  discoverability identity_discoverability NOT NULL DEFAULT 'PRIVATE',
  verification_state identity_verification_state NOT NULL DEFAULT 'UNVERIFIED',
  payability_state identity_payability_state NOT NULL DEFAULT 'UNAVAILABLE',
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economic_identities_username_shape
    CHECK (normalized_username ~ '^[a-z][a-z0-9_]{2,29}$'),
  CONSTRAINT economic_identities_username_normalized
    CHECK (normalized_username = lower(username) AND username = btrim(username)),
  CONSTRAINT economic_identities_display_name_length
    CHECK (char_length(display_name) BETWEEN 1 AND 80 AND display_name = btrim(display_name)),
  CONSTRAINT economic_identities_avatar_https
    CHECK (avatar_url IS NULL OR (length(avatar_url) <= 2048 AND avatar_url ~ '^https://')),
  CONSTRAINT economic_identities_version_nonnegative CHECK (version >= 0),
  CONSTRAINT economic_identities_updated_after_created CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX economic_identities_normalized_username_unique
  ON economic_identities (normalized_username);

CREATE TABLE payment_destinations (
  destination_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  destination_type payment_destination_type NOT NULL,
  destination_address text NOT NULL,
  status payment_destination_status NOT NULL DEFAULT 'ACTIVE',
  ownership_state destination_ownership_state NOT NULL DEFAULT 'UNVERIFIED',
  is_primary boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_destinations_address_length
    CHECK (length(destination_address) BETWEEN 32 AND 44 AND destination_address = btrim(destination_address)),
  CONSTRAINT payment_destinations_version_nonnegative CHECK (version >= 0),
  CONSTRAINT payment_destinations_updated_after_created CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX payment_destinations_type_address_unique
  ON payment_destinations (destination_type, destination_address);
CREATE UNIQUE INDEX payment_destinations_primary_per_type_unique
  ON payment_destinations (account_id, destination_type)
  WHERE is_primary;
CREATE INDEX payment_destinations_account_status_idx
  ON payment_destinations (account_id, destination_type, status, is_primary DESC);

CREATE FUNCTION protect_economic_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'economic identity linkage is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'economic identity mutations must increment version exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'economic identity updated_at cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER economic_identities_protect_lifecycle
  BEFORE UPDATE ON economic_identities
  FOR EACH ROW EXECUTE FUNCTION protect_economic_identity();

CREATE FUNCTION protect_payment_destination() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.destination_id IS DISTINCT FROM OLD.destination_id OR
     NEW.account_id IS DISTINCT FROM OLD.account_id OR
     NEW.destination_type IS DISTINCT FROM OLD.destination_type OR
     NEW.destination_address IS DISTINCT FROM OLD.destination_address OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment destination identity is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'payment destination mutations must increment version exactly once';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'payment destination updated_at cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_destinations_protect_lifecycle
  BEFORE UPDATE ON payment_destinations
  FOR EACH ROW EXECUTE FUNCTION protect_payment_destination();

CREATE TRIGGER economic_identities_reject_delete
  BEFORE DELETE ON economic_identities
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

CREATE TRIGGER payment_destinations_reject_delete
  BEFORE DELETE ON payment_destinations
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
