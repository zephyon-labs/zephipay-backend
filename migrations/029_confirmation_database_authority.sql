-- Correction only. 028 evidence is preserved but is not upgraded into trusted ceremony provenance.
CREATE TABLE economic_confirmation_policy_rules (
  fingerprint text PRIMARY KEY REFERENCES economic_confirmation_policies,
  configuration_revision bigint NOT NULL CHECK(configuration_revision>0)
);
CREATE TRIGGER economic_confirmation_policy_rules_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_policy_rules
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

-- Separate identity-verifier and issuer credentials are required: neither LOGIN can construct terminal authority alone.
CREATE TABLE economic_confirmation_proofs (
  proof_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES economic_confirmation_challenges,
  authentication_digest text NOT NULL CHECK(authentication_digest ~ '^[a-f0-9]{64}$'),
  authentication_issued_at timestamptz NOT NULL,
  authentication_expires_at timestamptz NOT NULL,
  reauthentication_digest text NOT NULL CHECK(reauthentication_digest ~ '^[a-f0-9]{64}$'),
  reauthentication_issued_at timestamptz NOT NULL,
  reauthentication_expires_at timestamptz NOT NULL,
  authentication_time timestamptz NOT NULL,
  assurance text NOT NULL CHECK(length(assurance) BETWEEN 1 AND 512),
  nonce text NOT NULL CHECK(nonce ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  provider_revision bigint NOT NULL,
  configuration text NOT NULL,
  policy_fingerprint text NOT NULL,
  verifier_login text NOT NULL DEFAULT session_user,
  verifier_generation bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE economic_confirmation_admissions (
  challenge_id uuid PRIMARY KEY REFERENCES economic_confirmation_consumptions,
  proof_id uuid NOT NULL UNIQUE REFERENCES economic_confirmation_proofs,
  consent_id uuid NOT NULL UNIQUE REFERENCES economic_consent_evidence,
  admitted_at timestamptz NOT NULL,
  database_actor text NOT NULL DEFAULT session_user
);
CREATE TRIGGER economic_confirmation_proofs_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_proofs
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_confirmation_admissions_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_admissions
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

-- Model B: admission-time eligibility, not a physical-COMMIT-time promise.
DROP TRIGGER economic_confirmation_issue_commit_guard ON economic_confirmation_challenges;
DROP TRIGGER economic_confirmation_consume_commit_guard ON economic_confirmation_consumptions;
DROP FUNCTION economic_confirmation_commit_guard();

-- Existing append-only evidence stays intact. Only the established consent revocation field changes.
-- No previously admitted generic consent is selected by this bridge-specific quarantine.
UPDATE economic_consent_evidence e SET revoked_at=GREATEST(clock_timestamp(),e.confirmed_at)
  WHERE e.revoked_at IS NULL AND EXISTS(SELECT 1 FROM economic_confirmation_consumptions c WHERE c.consent_id=e.consent_id);

CREATE FUNCTION economic_confirmation_root_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF current_user<>'zephipay_economic_admin' THEN RAISE EXCEPTION 'guarded confirmation operation required'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_confirmation_issue_root BEFORE INSERT ON economic_confirmation_challenges
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_root_write();
CREATE TRIGGER economic_confirmation_consume_root BEFORE INSERT ON economic_confirmation_consumptions
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_root_write();
CREATE TRIGGER economic_confirmation_proof_root BEFORE INSERT ON economic_confirmation_proofs
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_root_write();
CREATE TRIGGER economic_confirmation_admit_root BEFORE INSERT ON economic_confirmation_admissions
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_root_write();
CREATE TRIGGER economic_confirmation_consent_root BEFORE INSERT ON economic_consent_evidence
  FOR EACH ROW WHEN(NEW.session_reference LIKE 'zephipay:canonical:%') EXECUTE FUNCTION economic_confirmation_root_write();
CREATE TRIGGER economic_confirmation_event_root BEFORE INSERT ON economic_authority_events
  FOR EACH ROW WHEN(NEW.actor='auth0-confirmation-bridge') EXECUTE FUNCTION economic_confirmation_root_write();

CREATE FUNCTION economic_confirmation_caller(p_role text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE g bigint;
BEGIN
  SELECT credential_generation INTO g FROM economic_deployment_logins
    WHERE authority_role=p_role AND login_name=session_user FOR SHARE;
  IF g IS NULL THEN RAISE EXCEPTION 'unregistered confirmation service LOGIN'; END IF;
  RETURN g;
END; $$;

-- Internal locked canonical context. No operational role can call this helper directly.
CREATE FUNCTION economic_confirmation_context(p_session uuid,p_envelope text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a accounts; s account_sessions; t economic_attempts; h economic_attempt_heads;
  d economic_deployment_identity; p economic_confirmation_policies; ph economic_confirmation_policy_heads;
  rules economic_confirmation_policy_rules; policy jsonb; at_time timestamptz;
BEGIN
  SELECT * INTO STRICT t FROM economic_attempts WHERE envelope_digest=p_envelope;
  SELECT * INTO STRICT h FROM economic_attempt_heads WHERE intent_id=t.intent_id FOR UPDATE;
  -- The first read only locates the head. Re-read after its lock: cancellation/finalization may have won while we waited.
  SELECT * INTO STRICT t FROM economic_attempts WHERE envelope_digest=p_envelope FOR SHARE;
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

CREATE FUNCTION economic_confirmation_issued(p_id uuid) RETURNS economic_confirmation_challenges
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c economic_confirmation_challenges; x jsonb; p jsonb; at_time timestamptz;
BEGIN
  SELECT * INTO STRICT c FROM economic_confirmation_challenges WHERE challenge_id=p_id;
  x:=economic_confirmation_context(c.account_session_id,c.envelope_digest); p:=x->'policy'; at_time:=clock_timestamp();
  IF NOT COALESCE(c.account_id=(x->'account'->>'account_id')::uuid AND c.principal_id=x->'account'->>'actor_subject'
    AND c.account_version=(x->'account'->>'version')::bigint AND c.intent_id=x->'attempt'->>'intent_id'
    AND c.generation=(x->'attempt'->>'generation')::numeric AND c.environment=x->'deployment'->>'environment'
    AND c.action='confirm-economic-intent' AND c.policy_fingerprint=x->>'policyFingerprint' AND c.policy_revision=(p->>'revision')::bigint
    AND c.configuration=p->>'configuration' AND c.configuration_revision=(x->>'configurationRevision')::bigint
    AND c.provider_revision=(x->'deployment'->>'provider_key_revision')::bigint AND c.issuer=p->>'issuer'
    AND c.requested_at<=at_time AND c.expires_at>at_time
    AND c.expires_at<=(x->'session'->>'expires_at')::timestamptz AND c.expires_at<=(x->'attempt'->'envelope'->>'expiresAt')::timestamptz
    AND c.expires_at<=to_timestamp((p->>'expiresAt')::double precision)
    AND c.reauthentication=jsonb_build_object('nonce',c.nonce,'subject',c.provider_subject,'accountSessionId',c.account_session_id::text,
      'envelopeDigest',c.envelope_digest,'action',c.action,'requestedAt',floor(extract(epoch from c.requested_at))+1,
      'expiresAt',extract(epoch from c.expires_at),'maxAuthenticationAgeSeconds',(p->>'maxAuthenticationAgeSeconds')::integer,'acceptedAcr',p->'acceptedAcr'),false)
    THEN RAISE EXCEPTION 'expired, malformed or invalidated confirmation challenge'; END IF;
  IF NOT EXISTS(SELECT 1 FROM external_identities WHERE issuer=c.issuer AND subject=c.provider_subject AND account_id=c.account_id)
    OR EXISTS(SELECT 1 FROM economic_confirmation_consumptions WHERE challenge_id=c.challenge_id) THEN
    RAISE EXCEPTION 'unknown identity or already consumed challenge'; END IF;
  RETURN c;
END; $$;

CREATE FUNCTION economic_issue_confirmation(p_request uuid,p_session uuid,p_envelope text,p_auth jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE x jsonb; p jsonb; a jsonb; s jsonb; c economic_confirmation_challenges; id uuid:=gen_random_uuid(); n text:=encode(public.gen_random_bytes(32),'hex');
  at_time timestamptz; expiry timestamptz; prior economic_confirmation_challenges;
BEGIN
  PERFORM economic_confirmation_caller('issuer');
  x:=economic_confirmation_context(p_session,p_envelope);p:=x->'policy';a:=x->'account';s:=x->'session';at_time:=clock_timestamp();
  IF NOT COALESCE(p_request IS NOT NULL AND p_auth ?& ARRAY['subject','issuer','configuration','providerRevision','digest','issuedAt','expiresAt','scope']
    AND p_auth->>'issuer'=p->>'issuer' AND p_auth->>'configuration'=p->>'configuration'
    AND (p_auth->>'providerRevision')::bigint=(x->'deployment'->>'provider_key_revision')::bigint
    AND p_auth->>'scope'=p->>'requiredScope' AND p_auth->>'digest' ~ '^[a-f0-9]{64}$'
    AND to_timestamp((p_auth->>'issuedAt')::double precision)>=(s->>'created_at')::timestamptz
    AND to_timestamp((p_auth->>'issuedAt')::double precision)<=at_time AND to_timestamp((p_auth->>'expiresAt')::double precision)>at_time
    AND EXISTS(SELECT 1 FROM external_identities WHERE issuer=p->>'issuer' AND subject=p_auth->>'subject' AND account_id=(a->>'account_id')::uuid),false)
    THEN RAISE EXCEPTION 'invalid issuance authentication comparison'; END IF;
  SELECT * INTO prior FROM economic_confirmation_challenges WHERE account_session_id=p_session AND request_id=p_request;
  IF FOUND THEN
    IF prior.envelope_digest<>p_envelope THEN RAISE EXCEPTION 'creation request bound to another envelope'; END IF;
    RETURN prior.challenge_id;
  END IF;
  expiry:=date_trunc('second',LEAST(at_time+(p->>'challengeSeconds')::integer*interval '1 second',(s->>'expires_at')::timestamptz,
    (x->'attempt'->'envelope'->>'expiresAt')::timestamptz,to_timestamp((p_auth->>'expiresAt')::double precision),to_timestamp((p->>'expiresAt')::double precision)));
  IF expiry<=date_trunc('second',at_time)+interval '1 second' THEN RAISE EXCEPTION 'insufficient challenge lifetime'; END IF;
  INSERT INTO economic_confirmation_challenges(challenge_id,request_id,account_id,principal_id,account_session_id,account_version,envelope_digest,intent_id,generation,
    action,environment,issuer,provider_subject,configuration,configuration_revision,policy_fingerprint,policy_revision,provider_revision,authentication_digest,
    transaction_id,nonce,requested_at,expires_at,reauthentication)
    VALUES(id,p_request,(a->>'account_id')::uuid,a->>'actor_subject',p_session,(a->>'version')::bigint,p_envelope,x->'attempt'->>'intent_id',
      (x->'attempt'->>'generation')::numeric,'confirm-economic-intent',p->>'environment',p->>'issuer',p_auth->>'subject',p->>'configuration',
      (x->>'configurationRevision')::bigint,x->>'policyFingerprint',(p->>'revision')::bigint,(x->'deployment'->>'provider_key_revision')::bigint,p_auth->>'digest',
      gen_random_uuid(),n,at_time,expiry,jsonb_build_object('nonce',n,'subject',p_auth->>'subject','accountSessionId',p_session::text,'envelopeDigest',p_envelope,
      'action','confirm-economic-intent','requestedAt',floor(extract(epoch from at_time))+1,'expiresAt',extract(epoch from expiry),
      'maxAuthenticationAgeSeconds',(p->>'maxAuthenticationAgeSeconds')::integer,'acceptedAcr',p->'acceptedAcr'));
  RETURN id;
END; $$;

-- Identity is a trusted proof-attestation compartment, never a terminal-admission credential.
-- PostgreSQL validates canonical comparisons; accepted Auth0 cryptography stays in the existing verifier.
CREATE FUNCTION economic_record_confirmation_proof(p_id uuid,p_evidence jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c economic_confirmation_challenges; p jsonb; id uuid; g bigint; at_time timestamptz;
BEGIN
  g:=economic_confirmation_caller('identity');c:=economic_confirmation_issued(p_id);
  SELECT payload::jsonb INTO STRICT p FROM economic_confirmation_policies WHERE fingerprint=c.policy_fingerprint;
  at_time:=clock_timestamp();
  IF NOT COALESCE(p_evidence ?& ARRAY['authenticationDigest','authenticationIssuedAt','authenticationExpiresAt','providerEvidence','issuedAt','expiresAt','authTime',
    'assurance','nonce','subject','issuer','configuration','providerRevision','requestDigest','accountSessionId','envelopeDigest','transactionId','action','policyFingerprint','scope']
    AND p_evidence->>'authenticationDigest' ~ '^[a-f0-9]{64}$' AND p_evidence->>'providerEvidence' ~ '^[a-f0-9]{64}$'
    AND p_evidence->>'requestDigest' ~ '^[a-f0-9]{64}$' AND p_evidence->>'nonce'=c.nonce AND p_evidence->>'subject'=c.provider_subject
    AND p_evidence->>'issuer'=c.issuer AND p_evidence->>'configuration'=c.configuration AND (p_evidence->>'providerRevision')::bigint=c.provider_revision
    AND p_evidence->>'accountSessionId'=c.account_session_id::text AND p_evidence->>'envelopeDigest'=c.envelope_digest
    AND p_evidence->>'transactionId'=c.transaction_id::text AND p_evidence->>'action'=c.action
    AND p_evidence->>'policyFingerprint'=c.policy_fingerprint AND p_evidence->>'scope'=p->>'requiredScope'
    AND jsonb_typeof(p_evidence->'assurance')='string' AND p->'acceptedAcr' ? (p_evidence->>'assurance')
    AND to_timestamp((p_evidence->>'authTime')::double precision)>=c.requested_at
    AND to_timestamp((p_evidence->>'authTime')::double precision)<=to_timestamp((p_evidence->>'issuedAt')::double precision)
    AND to_timestamp((p_evidence->>'issuedAt')::double precision)<=at_time
    AND to_timestamp((p_evidence->>'authTime')::double precision)+(p->>'maxAuthenticationAgeSeconds')::integer*interval '1 second'>at_time
    AND to_timestamp((p_evidence->>'expiresAt')::double precision)>at_time
    AND to_timestamp((p_evidence->>'authenticationIssuedAt')::double precision)<=at_time
    AND to_timestamp((p_evidence->>'authenticationIssuedAt')::double precision)>=(SELECT created_at FROM account_sessions WHERE session_id=c.account_session_id)
    AND to_timestamp((p_evidence->>'authenticationExpiresAt')::double precision)>at_time,false)
    THEN RAISE EXCEPTION 'required verified reauthentication evidence rejected'; END IF;
  INSERT INTO economic_confirmation_proofs(challenge_id,authentication_digest,authentication_issued_at,authentication_expires_at,reauthentication_digest,
    reauthentication_issued_at,reauthentication_expires_at,authentication_time,assurance,nonce,request_digest,provider_revision,configuration,policy_fingerprint,verifier_generation)
    VALUES(c.challenge_id,p_evidence->>'authenticationDigest',to_timestamp((p_evidence->>'authenticationIssuedAt')::double precision),
      to_timestamp((p_evidence->>'authenticationExpiresAt')::double precision),p_evidence->>'providerEvidence',to_timestamp((p_evidence->>'issuedAt')::double precision),
      to_timestamp((p_evidence->>'expiresAt')::double precision),to_timestamp((p_evidence->>'authTime')::double precision),p_evidence->>'assurance',c.nonce,
      p_evidence->>'requestDigest',c.provider_revision,c.configuration,c.policy_fingerprint,g) RETURNING proof_id INTO id;
  RETURN id;
END; $$;

CREATE FUNCTION economic_admit_confirmation(p_id uuid,p_proof uuid,p_session uuid,p_envelope text,p_transaction uuid,p_request_digest text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c economic_confirmation_challenges; v economic_confirmation_proofs; p jsonb; at_time timestamptz; expiry timestamptz; id uuid:=gen_random_uuid(); ref text;
BEGIN
  PERFORM economic_confirmation_caller('issuer');c:=economic_confirmation_issued(p_id);
  SELECT * INTO STRICT v FROM economic_confirmation_proofs WHERE proof_id=p_proof;
  SELECT payload::jsonb INTO STRICT p FROM economic_confirmation_policies WHERE fingerprint=c.policy_fingerprint;
  PERFORM 1 FROM economic_deployment_logins WHERE authority_role='identity' AND login_name=v.verifier_login AND credential_generation=v.verifier_generation FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retired proof verifier credential'; END IF;
  IF NOT COALESCE(v.challenge_id=c.challenge_id AND v.nonce=c.nonce AND v.request_digest=p_request_digest
    AND c.account_session_id=p_session AND c.envelope_digest=p_envelope AND c.transaction_id=p_transaction
    AND v.provider_revision=c.provider_revision AND v.configuration=c.configuration AND v.policy_fingerprint=c.policy_fingerprint
    AND p->'acceptedAcr' ? v.assurance AND v.authentication_time>=c.requested_at AND v.authentication_time<=v.reauthentication_issued_at
    AND NOT EXISTS(SELECT 1 FROM economic_confirmation_admissions WHERE proof_id=p_proof),false)
    THEN RAISE EXCEPTION 'guarded confirmation proof/binding mismatch'; END IF;
  -- The linearization instant is observed after all canonical/provenance locks and before admission writes.
  at_time:=clock_timestamp();
  expiry:=LEAST(c.expires_at,v.authentication_expires_at,v.reauthentication_expires_at,
    v.authentication_time+(p->>'maxAuthenticationAgeSeconds')::integer*interval '1 second',at_time+(p->>'consentSeconds')::integer*interval '1 second');
  IF expiry<=at_time OR v.authentication_issued_at>at_time OR v.reauthentication_issued_at>at_time THEN RAISE EXCEPTION 'expired confirmation proof'; END IF;
  ref:='zephipay:canonical:'||c.account_session_id::text;
  INSERT INTO economic_session_bindings(issuer,provider_subject,provider_session_reference,account_session_id)
    VALUES(c.issuer,c.provider_subject,ref,c.account_session_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM economic_session_bindings WHERE issuer=c.issuer AND provider_subject=c.provider_subject AND provider_session_reference=ref
    AND account_session_id=c.account_session_id) THEN RAISE EXCEPTION 'canonical session binding mismatch'; END IF;
  INSERT INTO economic_consent_evidence(consent_id,envelope_digest,principal_id,issuer,audience,context,provider_subject,authentication_reference,session_reference,
    authenticated_at,confirmed_at,expires_at,account_session_id)
    VALUES(id,c.envelope_digest,c.principal_id,c.issuer,p->>'audience','zephipay-economic-consent-v1',c.provider_subject,v.reauthentication_digest,ref,
      v.reauthentication_issued_at,at_time,expiry,c.account_session_id);
  INSERT INTO economic_confirmation_consumptions(challenge_id,consent_id,authentication_digest,reauthentication_digest,confirmation_request_digest,authentication_time,assurance,confirmed_at,expires_at)
    VALUES(c.challenge_id,id,v.authentication_digest,v.reauthentication_digest,v.request_digest,v.authentication_time,v.assurance,at_time,expiry);
  INSERT INTO economic_confirmation_admissions(challenge_id,proof_id,consent_id,admitted_at) VALUES(c.challenge_id,v.proof_id,id,at_time);
  INSERT INTO economic_authority_events(event_type,actor,intent_id,generation,consent_id,reference)
    VALUES('CONSENT_ACCEPTED','auth0-confirmation-bridge',c.intent_id,c.generation,id,c.challenge_id::text);
  RETURN id;
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
JOIN economic_attempt_heads h USING(intent_id) JOIN economic_attempts t ON t.envelope_digest=c.envelope_digest
JOIN economic_deployment_identity d ON d.environment=c.environment LEFT JOIN economic_confirmation_policy_heads p ON p.deployment_id=d.deployment_id
LEFT JOIN economic_confirmation_policy_rules rules ON rules.fingerprint=p.fingerprint
LEFT JOIN economic_confirmation_consumptions r USING(challenge_id) LEFT JOIN economic_confirmation_admissions admitted USING(challenge_id);

REVOKE ALL ON economic_confirmation_policy_rules,economic_confirmation_proofs,economic_confirmation_admissions FROM PUBLIC;
DO $$ DECLARE f record; col record; r text; BEGIN
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('economic_confirmation_root_write','economic_confirmation_caller','economic_confirmation_context','economic_confirmation_issued',
      'economic_issue_confirmation','economic_record_confirmation_proof','economic_admit_confirmation') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
  -- Upgrade closes existing operational table AND column grants before the provisioning script is rerun.
  FOREACH r IN ARRAY ARRAY['zephipay_economic_identity','zephipay_economic_app','zephipay_economic_issuer','zephipay_economic_signer','zephipay_economic_observer','zephipay_economic_reader'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON economic_confirmation_challenges,economic_confirmation_consumptions FROM %I',r);
      FOR col IN SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE c.oid IN ('economic_confirmation_challenges'::regclass,'economic_confirmation_consumptions'::regclass) AND a.attnum>0 AND NOT a.attisdropped LOOP
        EXECUTE format('REVOKE INSERT (%I),UPDATE (%I) ON %I FROM %I',col.attname,col.attname,col.relname,r);
      END LOOP;
    END IF;
  END LOOP;
END; $$;
