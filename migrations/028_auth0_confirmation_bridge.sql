-- Non-value, unmounted confirmation evidence. No existing payment flow is rewired.
CREATE TABLE economic_confirmation_policies (
  fingerprint text PRIMARY KEY CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  deployment_id uuid NOT NULL REFERENCES economic_deployment_identity(deployment_id),
  revision bigint NOT NULL CHECK(revision>0),
  payload text NOT NULL CHECK(octet_length(payload)<=32768),
  signature text NOT NULL CHECK(length(signature)=86),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  database_actor text NOT NULL DEFAULT session_user,
  UNIQUE(deployment_id,revision)
);
CREATE TABLE economic_confirmation_policy_heads (
  deployment_id uuid PRIMARY KEY REFERENCES economic_deployment_identity(deployment_id),
  fingerprint text NOT NULL REFERENCES economic_confirmation_policies,
  revision bigint NOT NULL CHECK(revision>0)
);
CREATE FUNCTION economic_confirmation_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'confirmation policy head cannot be deleted'; END IF;
  IF TG_OP='UPDATE' AND (NEW.deployment_id<>OLD.deployment_id OR NEW.revision<=OLD.revision) THEN
    RAISE EXCEPTION 'confirmation policy revision must advance';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM economic_confirmation_policies WHERE fingerprint=NEW.fingerprint AND deployment_id=NEW.deployment_id AND revision=NEW.revision) THEN
    RAISE EXCEPTION 'confirmation policy registration mismatch';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_confirmation_policy_head_guard BEFORE INSERT OR UPDATE OR DELETE ON economic_confirmation_policy_heads
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_policy_guard();
CREATE TRIGGER economic_confirmation_policies_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_policies
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

CREATE TABLE economic_confirmation_challenges (
  challenge_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts,
  principal_id text NOT NULL REFERENCES accounts(actor_subject),
  account_session_id uuid NOT NULL REFERENCES account_sessions,
  account_version bigint NOT NULL CHECK(account_version>=0),
  envelope_digest text NOT NULL REFERENCES economic_attempts(envelope_digest),
  intent_id text NOT NULL,
  generation numeric(20,0) NOT NULL,
  action text NOT NULL CHECK(action='confirm-economic-intent'),
  environment text NOT NULL CHECK(length(environment) BETWEEN 1 AND 512),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),
  provider_subject text NOT NULL CHECK(length(provider_subject) BETWEEN 1 AND 512),
  configuration text NOT NULL CHECK(configuration ~ '^[a-f0-9]{64}$'),
  configuration_revision bigint NOT NULL CHECK(configuration_revision>0),
  policy_fingerprint text NOT NULL REFERENCES economic_confirmation_policies,
  policy_revision bigint NOT NULL CHECK(policy_revision>0),
  provider_revision bigint NOT NULL CHECK(provider_revision>0),
  authentication_digest text NOT NULL CHECK(authentication_digest ~ '^[a-f0-9]{64}$'),
  transaction_id uuid NOT NULL UNIQUE,
  nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  reauthentication jsonb NOT NULL,
  database_actor text NOT NULL DEFAULT session_user,
  UNIQUE(account_session_id,request_id),
  FOREIGN KEY(intent_id,generation) REFERENCES economic_attempts,
  CHECK(principal_id='zp:account:'||account_id::text),
  CHECK(expires_at>requested_at),
  CHECK(reauthentication->>'nonce'=nonce AND reauthentication->>'accountSessionId'=account_session_id::text AND
    reauthentication->>'subject'=provider_subject AND reauthentication->>'envelopeDigest'=envelope_digest AND
    reauthentication->>'action'=action)
);
CREATE TABLE economic_confirmation_consumptions (
  challenge_id uuid PRIMARY KEY REFERENCES economic_confirmation_challenges,
  consent_id uuid NOT NULL UNIQUE REFERENCES economic_consent_evidence,
  authentication_digest text NOT NULL CHECK(authentication_digest ~ '^[a-f0-9]{64}$'),
  reauthentication_digest text NOT NULL CHECK(reauthentication_digest ~ '^[a-f0-9]{64}$'),
  confirmation_request_digest text NOT NULL CHECK(confirmation_request_digest ~ '^[a-f0-9]{64}$'),
  authentication_time timestamptz NOT NULL,
  assurance text NOT NULL CHECK(length(assurance) BETWEEN 1 AND 512),
  confirmed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>confirmed_at),
  database_actor text NOT NULL DEFAULT session_user
);
CREATE TRIGGER economic_confirmation_challenges_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_challenges
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_confirmation_consumptions_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_consumptions
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
-- Deferred checks run at commit, after asynchronous provider/endpoint checks and any database waits.
CREATE FUNCTION economic_confirmation_commit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c economic_confirmation_challenges; e economic_consent_evidence;
BEGIN
  IF NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'confirmation authority expired before commit'; END IF;
  IF TG_TABLE_NAME='economic_confirmation_consumptions' THEN
    SELECT * INTO STRICT c FROM economic_confirmation_challenges WHERE challenge_id=NEW.challenge_id;
    SELECT * INTO STRICT e FROM economic_consent_evidence WHERE consent_id=NEW.consent_id;
    IF e.envelope_digest<>c.envelope_digest OR e.principal_id<>c.principal_id OR e.account_session_id<>c.account_session_id
      OR e.issuer<>c.issuer OR e.provider_subject<>c.provider_subject OR e.authentication_reference<>NEW.reauthentication_digest
      OR e.confirmed_at<>NEW.confirmed_at OR e.expires_at<>NEW.expires_at OR NEW.expires_at>c.expires_at
      OR NEW.authentication_time<c.requested_at OR NEW.authentication_time>NEW.confirmed_at THEN
      RAISE EXCEPTION 'confirmation consumption/consent binding mismatch';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER economic_confirmation_issue_commit_guard AFTER INSERT ON economic_confirmation_challenges
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economic_confirmation_commit_guard();
CREATE CONSTRAINT TRIGGER economic_confirmation_consume_commit_guard AFTER INSERT ON economic_confirmation_consumptions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economic_confirmation_commit_guard();
-- Read projection has no nonce, token, raw artifact or mutable payment fields. Expiry is DB-clock derived.
CREATE VIEW economic_confirmation_summary AS
SELECT c.challenge_id,c.account_id,c.account_session_id,c.envelope_digest,c.intent_id,c.generation,
  c.policy_fingerprint,c.policy_revision,c.configuration,c.provider_revision,c.requested_at,c.expires_at,
  r.consent_id,r.confirmed_at,
  CASE WHEN r.challenge_id IS NOT NULL THEN 'CONFIRMED'
    WHEN c.expires_at<=clock_timestamp() THEN 'EXPIRED'
    WHEN a.status<>'ACTIVE' OR a.version<>c.account_version OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp()
      OR h.current_generation<>c.generation OR t.state<>'OPEN' OR p.fingerprint IS DISTINCT FROM c.policy_fingerprint
      OR d.provider_key_revision<>c.provider_revision THEN 'INVALIDATED'
    ELSE 'ISSUED' END AS state
FROM economic_confirmation_challenges c JOIN accounts a USING(account_id)
JOIN account_sessions s ON s.session_id=c.account_session_id
JOIN economic_attempt_heads h USING(intent_id) JOIN economic_attempts t ON t.envelope_digest=c.envelope_digest
JOIN economic_deployment_identity d ON d.environment=c.environment
LEFT JOIN economic_confirmation_policy_heads p ON p.deployment_id=d.deployment_id
LEFT JOIN economic_confirmation_consumptions r USING(challenge_id);
REVOKE ALL ON economic_confirmation_policies,economic_confirmation_policy_heads,economic_confirmation_challenges,
  economic_confirmation_consumptions,economic_confirmation_summary FROM PUBLIC;
REVOKE ALL ON FUNCTION economic_confirmation_policy_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION economic_confirmation_commit_guard() FROM PUBLIC;
