-- Auth0 owns the OIDC nonce/state/PKCE. The immutable ZephiPay nonce is never replaced.
-- Only the authenticated identity compartment can attest an SDK-validated callback.
CREATE TABLE economic_confirmation_sdk_transactions (
  binding_id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE REFERENCES economic_confirmation_challenges,
  state_digest text NOT NULL UNIQUE CHECK(state_digest ~ '^[a-f0-9]{64}$'),
  sdk_nonce text NOT NULL UNIQUE CHECK(sdk_nonce ~ '^[A-Za-z0-9_-]{32,128}$'),
  code_challenge text NOT NULL CHECK(code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  provider_session_reference text NOT NULL,
  redirect_uri text NOT NULL CHECK(length(redirect_uri) BETWEEN 1 AND 2048),
  return_to text NOT NULL UNIQUE,
  context jsonb NOT NULL,
  verifier_login text NOT NULL DEFAULT session_user,
  verifier_generation bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE economic_confirmation_sdk_callbacks (
  binding_id uuid PRIMARY KEY REFERENCES economic_confirmation_sdk_transactions,
  token_digest text NOT NULL UNIQUE CHECK(token_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  authentication_time timestamptz NOT NULL,
  assurance text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE economic_confirmation_proofs ADD COLUMN sdk_binding_id uuid UNIQUE REFERENCES economic_confirmation_sdk_callbacks;
CREATE TRIGGER economic_confirmation_sdk_transactions_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_sdk_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_confirmation_sdk_callbacks_immutable BEFORE UPDATE OR DELETE ON economic_confirmation_sdk_callbacks
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TRIGGER economic_confirmation_sdk_transactions_root BEFORE INSERT ON economic_confirmation_sdk_transactions
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_root_write();
CREATE TRIGGER economic_confirmation_sdk_callbacks_root BEFORE INSERT ON economic_confirmation_sdk_callbacks
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_root_write();

CREATE FUNCTION economic_confirmation_sdk_context(p_id uuid,p_auth jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c economic_confirmation_challenges; p jsonb; at_time timestamptz;
BEGIN
  c:=economic_confirmation_issued(p_id);
  SELECT payload::jsonb INTO STRICT p FROM economic_confirmation_policies WHERE fingerprint=c.policy_fingerprint;
  at_time:=clock_timestamp();
  IF NOT COALESCE(p_auth->>'subject'=c.provider_subject AND p_auth->>'issuer'=c.issuer AND p_auth->>'clientId'=p->>'clientId'
    AND p_auth->>'environment'=c.environment AND p_auth->>'configuration'=c.configuration
    AND (p_auth->>'keyRevision')::bigint=c.provider_revision AND p_auth->'scopes' ? (p->>'requiredScope')
    AND p_auth->>'tokenDigest' ~ '^[a-f0-9]{64}$'
    AND to_timestamp((p_auth->>'issuedAt')::double precision)>=(SELECT created_at FROM account_sessions WHERE session_id=c.account_session_id)
    AND to_timestamp((p_auth->>'issuedAt')::double precision)<=at_time AND to_timestamp((p_auth->>'expiresAt')::double precision)>at_time,false)
    THEN RAISE EXCEPTION 'SDK canonical authentication mismatch'; END IF;
  -- Derive all economic bindings from authoritative rows, never callback/browser claims.
  RETURN jsonb_build_object('challenge',to_jsonb(c),'clientId',p->>'clientId','audience',p->>'audience');
END; $$;

CREATE FUNCTION economic_bind_confirmation_sdk(p_id uuid,p_binding uuid,p_sdk jsonb,p_auth jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE x jsonb; g bigint;
BEGIN
  g:=economic_confirmation_caller('identity');x:=economic_confirmation_sdk_context(p_id,p_auth);
  IF NOT COALESCE(p_binding IS NOT NULL AND p_sdk->>'sdkNonce'<>x->'challenge'->>'nonce'
    AND p_sdk->>'returnTo'='/confirmation/auth0/result?binding='||p_binding::text
    AND p_sdk->>'clientId'=x->>'clientId' AND p_sdk->>'issuer'=x->'challenge'->>'issuer'
    AND p_sdk->>'codeChallengeMethod'='S256' AND p_sdk->>'maxAge'='0'
    AND EXISTS(SELECT 1 FROM economic_session_bindings WHERE issuer=x->'challenge'->>'issuer' AND provider_subject=x->'challenge'->>'provider_subject'
      AND provider_session_reference=p_sdk->>'providerSessionReference' AND account_session_id=(x->'challenge'->>'account_session_id')::uuid),false)
    OR EXISTS(SELECT 1 FROM economic_confirmation_proofs WHERE challenge_id=p_id)
    THEN RAISE EXCEPTION 'SDK transaction binding rejected'; END IF;
  INSERT INTO economic_confirmation_sdk_transactions(binding_id,challenge_id,state_digest,sdk_nonce,code_challenge,redirect_uri,return_to,context,verifier_generation,provider_session_reference)
    VALUES(p_binding,p_id,p_sdk->>'stateDigest',p_sdk->>'sdkNonce',p_sdk->>'codeChallenge',p_sdk->>'redirectUri',p_sdk->>'returnTo',x,g,p_sdk->>'providerSessionReference');
  RETURN x;
END; $$;

CREATE FUNCTION economic_read_confirmation_sdk(p_binding uuid,p_auth jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b economic_confirmation_sdk_transactions; x jsonb; g bigint;
BEGIN
  g:=economic_confirmation_caller('identity');
  SELECT * INTO STRICT b FROM economic_confirmation_sdk_transactions WHERE binding_id=p_binding;
  x:=economic_confirmation_sdk_context(b.challenge_id,p_auth);
  IF b.context<>x OR b.verifier_login<>session_user OR b.verifier_generation<>g
    THEN RAISE EXCEPTION 'invalidated SDK transaction context'; END IF;
  RETURN to_jsonb(b)||jsonb_build_object('callback',(SELECT to_jsonb(c) FROM economic_confirmation_sdk_callbacks c WHERE c.binding_id=p_binding),
    'proof',(SELECT to_jsonb(v) FROM economic_confirmation_proofs v WHERE v.sdk_binding_id=p_binding));
END; $$;

CREATE FUNCTION economic_record_confirmation_sdk_callback(p_binding uuid,p_evidence jsonb,p_auth jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b jsonb; c jsonb; r jsonb; at_time timestamptz;
BEGIN
  b:=economic_read_confirmation_sdk(p_binding,p_auth);c:=b->'context'->'challenge';r:=c->'reauthentication';at_time:=clock_timestamp();
  IF NOT COALESCE(p_evidence->>'stateDigest'=b->>'state_digest' AND p_evidence->>'sdkNonce'=b->>'sdk_nonce'
    AND p_evidence->>'subject'=c->>'provider_subject' AND p_evidence->>'issuer'=c->>'issuer'
    AND p_evidence->>'clientId'=b->'context'->>'clientId' AND p_evidence->>'returnTo'=b->>'return_to'
    AND (p_evidence->>'providerRevision')::bigint=(c->>'provider_revision')::bigint
    AND to_timestamp((p_evidence->>'authTime')::double precision)>=to_timestamp((r->>'requestedAt')::double precision)
    AND to_timestamp((p_evidence->>'authTime')::double precision)<=to_timestamp((p_evidence->>'issuedAt')::double precision)
    AND to_timestamp((p_evidence->>'issuedAt')::double precision)<=at_time
    AND to_timestamp((p_evidence->>'expiresAt')::double precision)>at_time
    AND to_timestamp((p_evidence->>'authTime')::double precision)+(r->>'maxAuthenticationAgeSeconds')::integer*interval '1 second'>at_time
    AND r->'acceptedAcr' ? (p_evidence->>'assurance')
    AND EXISTS(SELECT 1 FROM economic_session_bindings WHERE issuer=c->>'issuer' AND provider_subject=c->>'provider_subject'
      AND provider_session_reference='zephipay:sdk:'||(p_evidence->>'tokenDigest') AND account_session_id=(c->>'account_session_id')::uuid),false)
    THEN RAISE EXCEPTION 'SDK callback evidence mismatch or expired'; END IF;
  -- No upsert: replay is rejected even after process reconstruction or a lost callback response.
  INSERT INTO economic_confirmation_sdk_callbacks(binding_id,token_digest,issued_at,expires_at,authentication_time,assurance)
    VALUES(p_binding,p_evidence->>'tokenDigest',to_timestamp((p_evidence->>'issuedAt')::double precision),
      to_timestamp((p_evidence->>'expiresAt')::double precision),to_timestamp((p_evidence->>'authTime')::double precision),p_evidence->>'assurance');
END; $$;

CREATE FUNCTION economic_confirmation_sdk_proof_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b economic_confirmation_sdk_transactions; cb economic_confirmation_sdk_callbacks;
BEGIN
  SELECT * INTO b FROM economic_confirmation_sdk_transactions WHERE challenge_id=NEW.challenge_id;
  IF FOUND THEN
    SELECT * INTO STRICT cb FROM economic_confirmation_sdk_callbacks WHERE binding_id=b.binding_id;
    IF NOT COALESCE(NEW.reauthentication_digest=cb.token_digest AND NEW.reauthentication_issued_at=cb.issued_at
      AND NEW.reauthentication_expires_at=cb.expires_at AND NEW.authentication_time=cb.authentication_time AND NEW.assurance=cb.assurance
      AND NEW.verifier_login=b.verifier_login AND NEW.verifier_generation=b.verifier_generation,false)
      THEN RAISE EXCEPTION 'SDK callback proof mismatch'; END IF;
    NEW.sdk_binding_id:=b.binding_id;
  ELSIF NEW.sdk_binding_id IS NOT NULL THEN RAISE EXCEPTION 'unexpected SDK proof binding'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_confirmation_sdk_proof_guard BEFORE INSERT ON economic_confirmation_proofs
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_sdk_proof_guard();

CREATE FUNCTION economic_confirmation_sdk_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b economic_confirmation_sdk_transactions; v economic_confirmation_proofs;
BEGIN
  SELECT * INTO b FROM economic_confirmation_sdk_transactions WHERE challenge_id=NEW.challenge_id;
  IF FOUND THEN
    SELECT * INTO STRICT v FROM economic_confirmation_proofs WHERE proof_id=NEW.proof_id;
    IF v.sdk_binding_id IS DISTINCT FROM b.binding_id THEN RAISE EXCEPTION 'SDK-bound challenge requires SDK callback proof'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_confirmation_sdk_admission_guard BEFORE INSERT ON economic_confirmation_admissions
  FOR EACH ROW EXECUTE FUNCTION economic_confirmation_sdk_admission_guard();

REVOKE ALL ON economic_confirmation_sdk_transactions,economic_confirmation_sdk_callbacks FROM PUBLIC;
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('economic_confirmation_sdk_context','economic_bind_confirmation_sdk','economic_read_confirmation_sdk','economic_record_confirmation_sdk_callback',
     'economic_confirmation_sdk_proof_guard','economic_confirmation_sdk_admission_guard') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
END; $$;
