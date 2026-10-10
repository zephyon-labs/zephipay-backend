-- Non-value SDK decisions. Deliberately separate from execution's economic_runtime_evidence.
CREATE TABLE economic_runtime_test_profiles (
  profile_digest text PRIMARY KEY CHECK(profile_digest ~ '^[a-f0-9]{64}$'),
  deployment_id uuid NOT NULL REFERENCES economic_deployment_identity(deployment_id),
  profile jsonb NOT NULL,
  CHECK(COALESCE(profile->>'scope'='devnet-test-only' AND profile->>'policyId'='zephyon:test:devnet-usdc:v1',false))
);
CREATE TABLE economic_runtime_policy_heads (
  deployment_id uuid PRIMARY KEY REFERENCES economic_deployment_identity(deployment_id),
  profile_digest text NOT NULL REFERENCES economic_runtime_test_profiles
);
CREATE FUNCTION economic_runtime_policy_head_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.deployment_id<>OLD.deployment_id THEN RAISE EXCEPTION 'Runtime deployment identity immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM economic_runtime_test_profiles WHERE profile_digest=NEW.profile_digest AND deployment_id=NEW.deployment_id) THEN
    RAISE EXCEPTION 'Runtime policy head binding rejected';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_runtime_policy_head_binding BEFORE INSERT OR UPDATE ON economic_runtime_policy_heads
FOR EACH ROW EXECUTE FUNCTION economic_runtime_policy_head_guard();
CREATE TABLE economic_policy_decisions (
  decision_id text PRIMARY KEY,
  envelope_digest text NOT NULL UNIQUE REFERENCES economic_envelopes(envelope_digest),
  payment_id uuid NOT NULL UNIQUE REFERENCES economic_payment_preparations(payment_id),
  account_session_id uuid NOT NULL REFERENCES account_sessions(session_id),
  consent_id uuid NOT NULL REFERENCES economic_confirmation_consumptions(consent_id),
  profile_digest text NOT NULL REFERENCES economic_runtime_test_profiles,
  decision jsonb NOT NULL,
  evidence jsonb NOT NULL,
  evaluation_context jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=8),
  CHECK(COALESCE(decision->>'schema'='zephyon.runtime-policy-decision/v1' AND
    decision->>'decisionId'=decision_id AND decision->>'envelopeDigest'=envelope_digest AND
    decision->>'profileDigest'=profile_digest AND decision->>'status' IN ('APPROVED','REJECTED') AND
    decision->>'issuedAt'=evaluation_context->>'evaluatedAt',false))
);
CREATE TRIGGER economic_runtime_test_profiles_immutable BEFORE UPDATE OR DELETE ON economic_runtime_test_profiles
FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_policy_decisions_immutable BEFORE UPDATE OR DELETE ON economic_policy_decisions
FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE FUNCTION economic_policy_decision_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e economic_envelopes; p economic_payment_preparations; c economic_consent_evidence;
  s account_sessions; a accounts; profile economic_runtime_test_profiles; head economic_runtime_policy_heads; observed timestamptz;
BEGIN
  SELECT * INTO STRICT e FROM economic_envelopes WHERE envelope_digest=NEW.envelope_digest;
  PERFORM 1 FROM economic_attempt_heads WHERE intent_id=e.intent_id FOR UPDATE;
  SELECT * INTO STRICT p FROM economic_payment_preparations WHERE payment_id=NEW.payment_id;
  SELECT * INTO STRICT a FROM accounts WHERE actor_subject=e.envelope->'principal'->>'id' FOR SHARE;
  SELECT * INTO STRICT s FROM account_sessions WHERE session_id=NEW.account_session_id FOR SHARE;
  SELECT * INTO STRICT profile FROM economic_runtime_test_profiles WHERE profile_digest=NEW.profile_digest;
  SELECT * INTO STRICT head FROM economic_runtime_policy_heads WHERE deployment_id=profile.deployment_id FOR SHARE;
  SELECT * INTO STRICT c FROM economic_consent_evidence WHERE consent_id=NEW.consent_id FOR SHARE;
  observed:=clock_timestamp();
  IF NOT COALESCE(p.envelope_digest=NEW.envelope_digest AND p.account_session_id=s.session_id AND s.account_id=a.account_id AND
    c.envelope_digest=NEW.envelope_digest AND c.account_session_id=s.session_id AND c.principal_id=a.actor_subject AND
    NEW.decision_id=e.envelope->'runtime'->>'decisionId' AND NEW.decision->'runtimeReference'=e.envelope->'runtime' AND
    NEW.decision->>'configurationFingerprint'=profile.profile->>'configurationFingerprint' AND
    NEW.decision->>'configurationVersion'=profile.profile->>'configurationVersion' AND
    NEW.decision->>'policyVersion'=profile.profile->>'policyVersion' AND
    (NEW.decision->>'issuedAt')::timestamptz<=observed,false) THEN
    RAISE EXCEPTION 'Runtime decision canonical binding rejected';
  END IF;
  IF NEW.decision->>'status'='APPROVED' AND NOT COALESCE(
    a.status='ACTIVE' AND s.revoked_at IS NULL AND s.created_at<=observed AND s.expires_at>observed AND
    c.revoked_at IS NULL AND c.confirmed_at<=observed AND c.expires_at>observed AND e.state='OPEN' AND
    head.profile_digest=NEW.profile_digest AND NEW.profile_digest=e.envelope->'runtime'->>'evidenceDigest' AND
    (NEW.decision->>'expiresAt')::timestamptz>observed AND
    (NEW.decision->>'expiresAt')::timestamptz<=c.expires_at AND
    (NEW.decision->>'expiresAt')::timestamptz<=s.expires_at,false) THEN
    RAISE EXCEPTION 'Runtime approval no longer eligible';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_policy_decision_binding BEFORE INSERT ON economic_policy_decisions
FOR EACH ROW EXECUTE FUNCTION economic_policy_decision_guard();
REVOKE ALL ON economic_runtime_test_profiles,economic_runtime_policy_heads,economic_policy_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION economic_policy_decision_guard(),economic_runtime_policy_head_guard() FROM PUBLIC;
