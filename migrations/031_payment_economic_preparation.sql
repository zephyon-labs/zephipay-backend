-- Immutable Protocol envelopes exist before transaction-specific finalization attempts.
-- No message/blockhash placeholders and no grants of confirmation or finalization authority.
CREATE TABLE economic_envelopes (
  intent_id text NOT NULL REFERENCES economic_attempt_heads,
  generation numeric(20,0) NOT NULL CHECK(generation>0),
  attempt_id text NOT NULL UNIQUE,
  fence_token text NOT NULL UNIQUE,
  envelope_digest text NOT NULL UNIQUE CHECK(envelope_digest ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CANCELLED','FINALIZATION_COMMITTED')),
  PRIMARY KEY(intent_id,generation),
  CHECK(envelope->'attempt'->>'intentId'=intent_id),
  CHECK((envelope->'attempt'->>'generation')::numeric=generation),
  CHECK(envelope->'attempt'->>'attemptId'=attempt_id),
  CHECK(envelope->'attempt'->>'fenceToken'=fence_token)
);
INSERT INTO economic_envelopes SELECT intent_id,generation,attempt_id,fence_token,envelope_digest,envelope,state FROM economic_attempts;
CREATE FUNCTION economic_envelope_immutable_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'OPEN'
    OR NEW.state NOT IN ('CANCELLED','FINALIZATION_COMMITTED') OR NOT EXISTS(
      SELECT 1 FROM economic_attempts WHERE intent_id=NEW.intent_id AND generation=NEW.generation AND state=NEW.state)
    THEN RAISE EXCEPTION 'immutable envelope or unauthenticated execution state'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_envelopes_immutable BEFORE UPDATE OR DELETE ON economic_envelopes
FOR EACH ROW EXECUTE FUNCTION economic_envelope_immutable_guard();
ALTER TABLE economic_attempt_heads DROP CONSTRAINT economic_current_attempt_fk;
ALTER TABLE economic_attempt_heads ADD CONSTRAINT economic_current_attempt_fk
  FOREIGN KEY(intent_id,current_generation) REFERENCES economic_envelopes(intent_id,generation) DEFERRABLE INITIALLY DEFERRED;

-- Existing registration is unchanged. Its complete transaction record must extend the SAME frozen envelope.
CREATE FUNCTION economic_attempt_envelope_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e economic_envelopes;
BEGIN
  INSERT INTO economic_envelopes(intent_id,generation,attempt_id,fence_token,envelope_digest,envelope) VALUES(NEW.intent_id,NEW.generation,NEW.attempt_id,NEW.fence_token,NEW.envelope_digest,NEW.envelope)
    ON CONFLICT(intent_id,generation) DO NOTHING;
  SELECT * INTO STRICT e FROM economic_envelopes WHERE intent_id=NEW.intent_id AND generation=NEW.generation;
  IF ROW(e.attempt_id,e.fence_token,e.envelope_digest,e.envelope) IS DISTINCT FROM
    ROW(NEW.attempt_id,NEW.fence_token,NEW.envelope_digest,NEW.envelope) THEN RAISE EXCEPTION 'transaction attempt conflicts with prepared envelope'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_attempt_envelope_guard BEFORE INSERT ON economic_attempts
FOR EACH ROW EXECUTE FUNCTION economic_attempt_envelope_guard();
-- A state transition updates the canonical row under the SAME head lock. In REPEATABLE READ,
-- confirmation's FOR SHARE must reject an old snapshot after a cancellation/finalization wait.
CREATE FUNCTION economic_envelope_execution_state() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE economic_envelopes SET state=NEW.state WHERE intent_id=NEW.intent_id AND generation=NEW.generation AND state<>NEW.state;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_envelope_execution_state AFTER INSERT OR UPDATE ON economic_attempts
FOR EACH ROW EXECUTE FUNCTION economic_envelope_execution_state();
ALTER TABLE economic_consent_evidence DROP CONSTRAINT economic_consent_evidence_envelope_digest_fkey;
ALTER TABLE economic_consent_evidence ADD FOREIGN KEY(envelope_digest) REFERENCES economic_envelopes(envelope_digest);
ALTER TABLE economic_runtime_evidence DROP CONSTRAINT economic_runtime_evidence_envelope_digest_fkey;
ALTER TABLE economic_runtime_evidence ADD FOREIGN KEY(envelope_digest) REFERENCES economic_envelopes(envelope_digest);
ALTER TABLE economic_confirmation_challenges DROP CONSTRAINT economic_confirmation_challenges_envelope_digest_fkey;
ALTER TABLE economic_confirmation_challenges DROP CONSTRAINT economic_confirmation_challenges_intent_id_generation_fkey;
ALTER TABLE economic_confirmation_challenges ADD FOREIGN KEY(envelope_digest) REFERENCES economic_envelopes(envelope_digest);
ALTER TABLE economic_confirmation_challenges ADD FOREIGN KEY(intent_id,generation) REFERENCES economic_envelopes(intent_id,generation);

-- Explicit administrative, TEST-only configuration. No keys, RPC endpoints or approval result.
CREATE TABLE economic_payment_preparation_profiles (
  principal_id text PRIMARY KEY REFERENCES accounts(actor_subject),
  profile jsonb NOT NULL,
  CHECK(profile->>'mode'='controlled-non-value'),
  CHECK(profile->>'attestation'='TEST')
);
CREATE TRIGGER economic_payment_preparation_profiles_immutable BEFORE UPDATE OR DELETE ON economic_payment_preparation_profiles
FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TABLE economic_payment_preparations (
  payment_id uuid PRIMARY KEY REFERENCES payments(id),
  account_session_id uuid NOT NULL REFERENCES account_sessions(session_id),
  envelope_digest text NOT NULL UNIQUE REFERENCES economic_envelopes(envelope_digest),
  payment_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER economic_payment_preparations_immutable BEFORE UPDATE OR DELETE ON economic_payment_preparations
FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
-- Snapshot includes the original version and request hash as well as the full economic meaning.
CREATE FUNCTION economic_payment_snapshot(p payments) RETURNS jsonb LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_object('id',p.id,'principal',p.actor_subject,'version',p.version::text,'requestHash',encode(p.request_hash,'hex'),
    'network',p.network,'rail',p.rail,'asset',p.asset,'mint',p.mint_address,'recipient',p.recipient_address,'amount',p.amount_raw::text,
    'purpose',p.purpose,'recipientType',p.recipient_type,'recipientAccount',p.recipient_account_id,'recipientSnapshot',p.recipient_snapshot)
$$;
CREATE FUNCTION economic_prepared_payment_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF economic_payment_snapshot(NEW) IS DISTINCT FROM economic_payment_snapshot(OLD) AND
    EXISTS(SELECT 1 FROM economic_payment_preparations WHERE payment_id=OLD.id) THEN
    RAISE EXCEPTION 'prepared payment economics and version are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_prepared_payment_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION economic_prepared_payment_guard();
-- The database independently binds the immutable association to canonical payment/session truth.
CREATE FUNCTION economic_payment_preparation_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p payments; s account_sessions; e economic_envelopes;
BEGIN
  SELECT * INTO STRICT e FROM economic_envelopes WHERE envelope_digest=NEW.envelope_digest;
  PERFORM 1 FROM economic_attempt_heads WHERE intent_id=e.intent_id FOR UPDATE;
  SELECT * INTO STRICT p FROM payments WHERE id=NEW.payment_id FOR SHARE;
  SELECT * INTO STRICT s FROM account_sessions WHERE session_id=NEW.account_session_id FOR SHARE;
  IF NOT COALESCE(p.status='AWAITING_CONFIRMATION' AND p.version=0 AND p.user_confirmed_at IS NULL AND p.execution_started_at IS NULL
    AND s.revoked_at IS NULL AND s.created_at<=clock_timestamp() AND s.expires_at>clock_timestamp()
    AND p.actor_subject='zp:account:'||s.account_id::text AND e.envelope->'principal'->>'id'=p.actor_subject
    AND e.intent_id='zephipay:payment:'||p.id::text AND e.generation=1
    AND e.envelope->'amount'->>'atomicUnits'=p.amount_raw::text AND e.envelope->'amount'->'asset'->>'mint'=p.mint_address
    AND e.envelope->'amount'->'asset'->'network'->>'environment'='devnet' AND p.network='solana-devnet'
    AND e.envelope->'recipient'->>'wallet'=p.recipient_address AND p.recipient_type='DIRECT_WALLET'
    AND e.envelope->'purpose'->>'reference'=p.id::text AND e.envelope->'source'->>'mode'='devnet-server'
    AND NEW.payment_snapshot=economic_payment_snapshot(p),false) THEN RAISE EXCEPTION 'prepared payment binding mismatch'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_payment_preparation_guard BEFORE INSERT ON economic_payment_preparations
FOR EACH ROW EXECUTE FUNCTION economic_payment_preparation_guard();
-- No preparation can be interpreted as an executed transaction. Existing attempt state remains authoritative when present.
CREATE VIEW economic_envelope_context AS
SELECT intent_id,generation,attempt_id,fence_token,envelope_digest,envelope,state FROM economic_envelopes;

-- Preserve migration 029 admission/policy/identity checks; change only the immutable envelope source.
CREATE OR REPLACE FUNCTION economic_confirmation_context(p_session uuid,p_envelope text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a accounts; s account_sessions; t economic_envelope_context; h economic_attempt_heads;
  d economic_deployment_identity; p economic_confirmation_policies; ph economic_confirmation_policy_heads;
  rules economic_confirmation_policy_rules; policy jsonb; at_time timestamptz;
BEGIN
  SELECT * INTO STRICT t FROM economic_envelope_context WHERE envelope_digest=p_envelope;
  SELECT * INTO STRICT h FROM economic_attempt_heads WHERE intent_id=t.intent_id FOR UPDATE;
  -- The first read only locates the head. Re-read after its lock: cancellation/finalization may have won while we waited.
  PERFORM 1 FROM economic_envelopes WHERE envelope_digest=p_envelope FOR SHARE;
  SELECT * INTO STRICT t FROM economic_envelope_context WHERE envelope_digest=p_envelope;
  IF EXISTS(SELECT 1 FROM economic_payment_preparations WHERE envelope_digest=p_envelope AND account_session_id<>p_session)
    THEN RAISE EXCEPTION 'prepared payment canonical session mismatch'; END IF;
  SELECT * INTO STRICT a FROM accounts WHERE actor_subject=t.envelope->'principal'->>'id' FOR SHARE;
  SELECT * INTO STRICT s FROM account_sessions WHERE session_id=p_session FOR SHARE;
  SELECT * INTO STRICT d FROM economic_deployment_identity WHERE singleton;
  SELECT * INTO STRICT ph FROM economic_confirmation_policy_heads WHERE deployment_id=d.deployment_id FOR SHARE;
  SELECT * INTO STRICT d FROM economic_deployment_identity WHERE singleton FOR SHARE;
  SELECT * INTO STRICT p FROM economic_confirmation_policies WHERE fingerprint=ph.fingerprint;
  SELECT * INTO STRICT rules FROM economic_confirmation_policy_rules WHERE fingerprint=p.fingerprint;
  policy:=p.payload::jsonb;
  -- All security fields must be present and non-null. Null predicates never count as acceptance.
  IF NOT COALESCE(policy ?& ARRAY['type','mode','deploymentId','environment','configuration','revision','issuer','audience','clientId',
    'dialect','algorithm','flow','attestation','reauthentication','issuedAt','expiresAt','requiredScope','challengeSeconds','maxAuthenticationAgeSeconds','consentSeconds','acceptedAcr']
    AND policy->>'type'='zephipay-confirmation-policy-v1' AND policy->>'mode'='non-value'
    AND policy->>'dialect'='auth0' AND policy->>'algorithm'='RS256' AND policy->>'flow'='authorization-code-pkce'
    AND encode(public.digest(p.payload,'sha256'),'hex')=p.fingerprint
    AND (policy->>'deploymentId')::uuid=d.deployment_id AND policy->>'environment'=d.environment
    AND (policy->>'configuration') ~ '^[a-f0-9]{64}$' AND (policy->>'revision')::bigint=p.revision AND p.revision=ph.revision
    AND policy->>'attestation' IN ('TEST','ATTESTED') AND policy->>'reauthentication' IN ('TEST','ATTESTED')
    AND length(policy->>'issuer')>0 AND length(policy->>'audience')>0 AND length(policy->>'clientId')>0
    AND length(policy->>'requiredScope')>0 AND jsonb_typeof(policy->'acceptedAcr')='array'
    AND jsonb_array_length(policy->'acceptedAcr') BETWEEN 1 AND 16
    AND (policy->>'challengeSeconds')::integer BETWEEN 1 AND 600 AND (policy->>'maxAuthenticationAgeSeconds')::integer BETWEEN 1 AND 600
    AND (policy->>'consentSeconds')::integer BETWEEN 1 AND 600, false) THEN RAISE EXCEPTION 'invalid registered confirmation policy'; END IF;
  -- Qualification remains based on the existing immutable registry/envelope, not alternate Backend asset rules.
  PERFORM 1 FROM economic_network_registry WHERE identity=t.envelope->'amount'->'asset'->'network'
    AND revoked_at IS NULL AND effective_at<=clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unqualified confirmation network'; END IF;
  PERFORM 1 FROM economic_asset_registry WHERE identity=t.envelope->'amount'->'asset' AND use_role='PAYMENT'
    AND revoked_at IS NULL AND effective_at<=clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unqualified confirmation asset'; END IF;
  PERFORM 1 FROM economic_asset_registry WHERE identity=t.envelope->'fee'->'asset' AND use_role='FEE'
    AND revoked_at IS NULL AND effective_at<=clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unqualified confirmation fee'; END IF;
  at_time:=clock_timestamp();
  IF NOT COALESCE(a.status='ACTIVE' AND a.actor_subject='zp:account:'||a.account_id::text AND s.account_id=a.account_id
    AND s.revoked_at IS NULL AND s.created_at<=at_time AND s.expires_at>at_time
    AND h.principal_id=a.actor_subject AND h.current_generation=t.generation AND t.state='OPEN'
    AND t.envelope->'attempt'->>'intentId'=t.intent_id AND (t.envelope->'attempt'->>'generation')::numeric=t.generation
    AND t.envelope->'amount'->'asset'->'network'->>'environment'='devnet'
    AND (t.envelope->>'createdAt')::timestamptz<=at_time AND (t.envelope->>'expiresAt')::timestamptz>at_time
    AND to_timestamp((policy->>'issuedAt')::double precision)<=at_time AND to_timestamp((policy->>'expiresAt')::double precision)>at_time,false)
    THEN RAISE EXCEPTION 'ineligible canonical confirmation context'; END IF;
  RETURN jsonb_build_object('account',to_jsonb(a),'session',to_jsonb(s),'attempt',to_jsonb(t),'deployment',to_jsonb(d),
    'policy',policy,'policyFingerprint',p.fingerprint,'configurationRevision',rules.configuration_revision);
END; $$;

CREATE OR REPLACE VIEW economic_confirmation_summary AS
SELECT c.challenge_id,c.account_id,c.account_session_id,c.envelope_digest,c.intent_id,c.generation,
  c.policy_fingerprint,c.policy_revision,c.configuration,c.provider_revision,c.requested_at,c.expires_at,r.consent_id,r.confirmed_at,
  CASE WHEN admitted.challenge_id IS NOT NULL THEN 'CONFIRMED'
    WHEN r.challenge_id IS NOT NULL THEN 'LEGACY_UNVERIFIED'
    WHEN c.expires_at<=clock_timestamp() THEN 'EXPIRED'
    WHEN a.status<>'ACTIVE' OR a.version<>c.account_version OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp()
      OR h.current_generation<>c.generation OR t.state<>'OPEN' OR p.fingerprint IS DISTINCT FROM c.policy_fingerprint
      OR d.provider_key_revision<>c.provider_revision OR rules.configuration_revision IS DISTINCT FROM c.configuration_revision THEN 'INVALIDATED'
    ELSE 'ISSUED' END AS state
FROM economic_confirmation_challenges c JOIN accounts a USING(account_id) JOIN account_sessions s ON s.session_id=c.account_session_id
JOIN economic_attempt_heads h USING(intent_id) JOIN economic_envelope_context t ON t.envelope_digest=c.envelope_digest
JOIN economic_deployment_identity d ON d.environment=c.environment LEFT JOIN economic_confirmation_policy_heads p ON p.deployment_id=d.deployment_id
LEFT JOIN economic_confirmation_policy_rules rules ON rules.fingerprint=p.fingerprint
LEFT JOIN economic_confirmation_consumptions r USING(challenge_id) LEFT JOIN economic_confirmation_admissions admitted USING(challenge_id);

REVOKE ALL ON economic_envelopes,economic_envelope_context,economic_payment_preparations,economic_payment_preparation_profiles FROM PUBLIC;
REVOKE ALL ON FUNCTION economic_envelope_immutable_guard(),economic_envelope_execution_state(),economic_attempt_envelope_guard(),economic_payment_snapshot(payments),economic_prepared_payment_guard(),economic_payment_preparation_guard() FROM PUBLIC;
