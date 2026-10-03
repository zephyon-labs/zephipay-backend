-- Empty until explicitly provisioned by an offline administrator. No LOGINs, secrets or live defaults.
CREATE TABLE economic_deployment_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  deployment_id uuid NOT NULL UNIQUE,
  environment text NOT NULL CHECK(length(environment) BETWEEN 1 AND 128),
  database_name text NOT NULL CHECK(length(database_name) BETWEEN 1 AND 63),
  provider_key_revision bigint NOT NULL CHECK(provider_key_revision>0)
);
CREATE TABLE economic_deployment_logins (
  authority_role text PRIMARY KEY CHECK(authority_role IN ('identity','app','issuer','signer','observer','reader')),
  login_name text NOT NULL UNIQUE CHECK(length(login_name) BETWEEN 1 AND 63),
  credential_generation bigint NOT NULL CHECK(credential_generation>0)
);
CREATE TABLE economic_provider_token_uses (
  token_id text PRIMARY KEY CHECK(token_id ~ '^[a-f0-9]{64}$'),
  token_digest text NOT NULL CHECK(token_digest ~ '^[a-f0-9]{64}$'),
  account_session_id uuid NOT NULL REFERENCES account_sessions,
  account_version bigint NOT NULL CHECK(account_version>=0),
  action text NOT NULL CHECK(action IN ('create-session','bind-session','revoke-session','consent')),
  resource_reference text NOT NULL CHECK(length(resource_reference) BETWEEN 1 AND 192),
  issued_at timestamptz NOT NULL,
  authentication_time timestamptz,
  key_revision bigint NOT NULL CHECK(key_revision>0),
  database_actor text NOT NULL DEFAULT session_user,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(authentication_time IS NULL OR authentication_time<=issued_at)
);
CREATE TRIGGER economic_provider_token_uses_immutable BEFORE UPDATE OR DELETE ON economic_provider_token_uses
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
REVOKE ALL ON economic_deployment_identity,economic_deployment_logins,economic_provider_token_uses FROM PUBLIC;
