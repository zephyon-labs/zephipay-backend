-- No live composition changes. Existing accounts/account_sessions remain the identity authority.
CREATE TABLE economic_session_bindings (
  issuer text NOT NULL, provider_subject text NOT NULL, provider_session_reference text NOT NULL,
  account_session_id uuid NOT NULL REFERENCES account_sessions,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (issuer,provider_subject,provider_session_reference),
  UNIQUE (issuer,provider_subject,provider_session_reference,account_session_id),
  CHECK (length(issuer) BETWEEN 1 AND 512 AND length(provider_subject) BETWEEN 1 AND 512 AND length(provider_session_reference) BETWEEN 1 AND 512)
);
CREATE TRIGGER economic_session_binding_immutable BEFORE UPDATE OR DELETE ON economic_session_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
ALTER TABLE economic_consent_evidence ADD COLUMN account_session_id uuid REFERENCES account_sessions;
ALTER TABLE economic_consent_evidence ADD CONSTRAINT economic_consent_session_binding_fk
  FOREIGN KEY (issuer,provider_subject,session_reference,account_session_id)
  REFERENCES economic_session_bindings(issuer,provider_subject,provider_session_reference,account_session_id);
-- Historical NULL is not backfilled from a client/provider sid; it cannot grant new signer authority.
CREATE FUNCTION economic_session_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM external_identities e JOIN account_sessions s USING(account_id)
    WHERE e.issuer=NEW.issuer AND e.subject=NEW.provider_subject AND s.session_id=NEW.account_session_id) THEN
    RAISE EXCEPTION 'provider session must bind its canonical account session';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_session_binding_guard BEFORE INSERT ON economic_session_bindings
  FOR EACH ROW EXECUTE FUNCTION economic_session_binding_guard();
CREATE FUNCTION economic_consent_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s account_sessions%ROWTYPE;
BEGIN
  IF NEW.account_session_id IS NULL OR NEW.session_reference IS NULL THEN RAISE EXCEPTION 'authoritative account session required'; END IF;
  PERFORM 1 FROM accounts WHERE actor_subject=NEW.principal_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inactive consent principal'; END IF;
  SELECT * INTO s FROM account_sessions WHERE session_id=NEW.account_session_id FOR SHARE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.created_at>clock_timestamp() OR
    'zp:account:'||s.account_id::text<>NEW.principal_id OR NEW.expires_at>s.expires_at THEN
    RAISE EXCEPTION 'invalid or revoked consent session';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_consent_session_guard BEFORE INSERT ON economic_consent_evidence
  FOR EACH ROW EXECUTE FUNCTION economic_consent_session_guard();

-- Immutable budget versions; administrative status/current version live in one serialized family head.
ALTER TABLE economic_sponsor_budgets DROP CONSTRAINT economic_sponsor_budgets_network_sponsor_public_key_sponsor_key;
CREATE TABLE economic_budget_heads (
  family_id text PRIMARY KEY,
  network jsonb NOT NULL, sponsor_public_key text NOT NULL, sponsor_key_version text NOT NULL,
  current_budget_id text NOT NULL UNIQUE REFERENCES economic_sponsor_budgets,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  UNIQUE (network,sponsor_public_key,sponsor_key_version)
);
CREATE TABLE economic_budget_versions (
  budget_id text PRIMARY KEY REFERENCES economic_sponsor_budgets,
  family_id text NOT NULL REFERENCES economic_budget_heads,
  version bigint NOT NULL CHECK (version>0),
  UNIQUE (family_id,version), UNIQUE (budget_id,version)
);
INSERT INTO economic_budget_heads(family_id,network,sponsor_public_key,sponsor_key_version,current_budget_id)
  SELECT budget_id,network,sponsor_public_key,sponsor_key_version,budget_id FROM economic_sponsor_budgets;
INSERT INTO economic_budget_versions SELECT budget_id,budget_id,1 FROM economic_sponsor_budgets;
ALTER TABLE economic_finalizations ADD COLUMN budget_version bigint NOT NULL DEFAULT 1;
ALTER TABLE economic_finalizations ADD CONSTRAINT economic_reservation_budget_version_fk
  FOREIGN KEY(budget_id,budget_version) REFERENCES economic_budget_versions(budget_id,version);
CREATE TRIGGER economic_budget_version_immutable BEFORE UPDATE OR DELETE ON economic_budget_versions
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE FUNCTION economic_budget_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'budget family cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-ARRAY['current_budget_id','status','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_budget_id','status','revision']) OR
    NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'immutable budget family or stale administrative revision'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_budget_head_guard BEFORE UPDATE OR DELETE ON economic_budget_heads
  FOR EACH ROW EXECUTE FUNCTION economic_budget_head_guard();
CREATE FUNCTION economic_budget_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM economic_budget_heads h JOIN economic_budget_versions v ON v.budget_id=h.current_budget_id
    JOIN economic_sponsor_budgets b USING(budget_id) WHERE h.family_id=NEW.family_id AND v.family_id=h.family_id
    AND b.network=h.network AND b.sponsor_public_key=h.sponsor_public_key AND b.sponsor_key_version=h.sponsor_key_version) THEN
    RAISE EXCEPTION 'budget head requires matching immutable version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER economic_budget_version_guard AFTER INSERT OR UPDATE ON economic_budget_heads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economic_budget_version_guard();

CREATE TABLE economic_signer_contact_authority (
  finalization_id uuid PRIMARY KEY REFERENCES economic_finalizations,
  signer_operation_id uuid NOT NULL UNIQUE,
  tuple_digest text NOT NULL,
  origin text NOT NULL CHECK(origin IN ('LEGACY_STATE','CONTACT_COMMIT')),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO economic_signer_contact_authority(finalization_id,signer_operation_id,tuple_digest,origin,committed_at)
  SELECT finalization_id,signer_operation_id,tuple_digest,'LEGACY_STATE',created_at FROM economic_finalizations WHERE signer_state<>'NOT_CONTACTED';
CREATE TRIGGER economic_contact_authority_immutable BEFORE UPDATE OR DELETE ON economic_signer_contact_authority
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TABLE economic_expiry_records (
  finalization_id uuid PRIMARY KEY REFERENCES economic_finalizations,
  generation numeric(20,0) NOT NULL, exposure_id uuid NOT NULL UNIQUE,
  old_state text NOT NULL CHECK(old_state='NOT_CONTACTED'),
  new_state text NOT NULL CHECK(new_state='EXPIRED_NEVER_CONTACTED'),
  reasons jsonb NOT NULL CHECK(jsonb_typeof(reasons)='array' AND jsonb_array_length(reasons)>0),
  consent_id uuid NOT NULL, runtime_id text NOT NULL, account_session_id uuid,
  base_released numeric(20,0) NOT NULL CHECK(base_released>=0),
  priority_released numeric(20,0) NOT NULL CHECK(priority_released>=0),
  rent_released numeric(20,0) NOT NULL CHECK(rent_released>=0),
  actor text NOT NULL, database_actor text NOT NULL DEFAULT session_user, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER economic_expiry_record_immutable BEFORE UPDATE OR DELETE ON economic_expiry_records
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE TABLE economic_effect_evidence (
  evidence_id uuid PRIMARY KEY,
  finalization_id uuid NOT NULL REFERENCES economic_finalizations,
  kind text NOT NULL CHECK(kind IN ('POSSIBLE_EFFECT','FINALIZED_ACCOUNTING')),
  network jsonb NOT NULL, transaction_id text, reference text NOT NULL,
  base_consumed numeric(20,0), priority_consumed numeric(20,0), rent_consumed numeric(20,0),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(finalization_id,reference),
  CHECK ((kind='POSSIBLE_EFFECT' AND base_consumed IS NULL AND priority_consumed IS NULL AND rent_consumed IS NULL) OR
    (kind='FINALIZED_ACCOUNTING' AND transaction_id IS NOT NULL AND base_consumed>=0 AND priority_consumed>=0 AND rent_consumed>=0
      AND base_consumed IS NOT NULL AND priority_consumed IS NOT NULL AND rent_consumed IS NOT NULL))
);
CREATE TRIGGER economic_effect_evidence_immutable BEFORE UPDATE OR DELETE ON economic_effect_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

-- Classify future callback failures using Protocol signature verification; legacy rejected bytes remain uncertain.
ALTER TABLE economic_callback_evidence DROP CONSTRAINT economic_callback_evidence_validation_check;
ALTER TABLE economic_callback_evidence ADD CONSTRAINT economic_callback_evidence_validation_check
  CHECK(validation IN ('CUSTOMER_VERIFIED','REJECTED','INVALID_ARTIFACT','SPONSOR_RESULT_PRESENT'));
CREATE INDEX economic_callback_authority_idx ON economic_callback_evidence(intent_id,generation,validation);
CREATE FUNCTION economic_callback_authority_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- Same intent authority lock as contact/expiry. Evidence arriving after expiry cannot revive a terminal operation.
  PERFORM 1 FROM economic_attempt_heads WHERE intent_id=NEW.intent_id FOR UPDATE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_callback_authority_guard BEFORE INSERT ON economic_callback_evidence
  FOR EACH ROW EXECUTE FUNCTION economic_callback_authority_guard();

-- Replace only lifecycle checks, leaving immutable identity, artifact bounds and tuple constraints intact.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='economic_finalizations'::regclass AND contype='c'
    AND (pg_get_constraintdef(oid) LIKE '%signer_state%' OR pg_get_constraintdef(oid) LIKE '%exposure_state%') LOOP
    EXECUTE format('ALTER TABLE economic_finalizations DROP CONSTRAINT %I',c.conname);
  END LOOP;
END; $$;
ALTER TABLE economic_finalizations ADD CONSTRAINT economic_finalization_lifecycle_v2 CHECK (
  signer_state IN ('NOT_CONTACTED','CONTACT_COMMITTED','RESULT_UNKNOWN','REFUSED','RESULT_AVAILABLE','EXPIRED_NEVER_CONTACTED') AND
  exposure_state IN ('RESERVED','UNCERTAIN','RELEASED','CONSUMED') AND
  ((signer_state='REFUSED')=(refusal_reference IS NOT NULL)) AND
  ((signer_state='RESULT_AVAILABLE' AND result_artifact IS NOT NULL AND artifact_reference IS NOT NULL AND final_transaction_id IS NOT NULL) OR
    (signer_state<>'RESULT_AVAILABLE' AND result_artifact IS NULL AND artifact_reference IS NULL AND final_transaction_id IS NULL)) AND
  ((signer_state='NOT_CONTACTED' AND exposure_state='RESERVED') OR
   (signer_state IN ('CONTACT_COMMITTED','RESULT_UNKNOWN') AND exposure_state='UNCERTAIN') OR
   (signer_state='RESULT_AVAILABLE' AND exposure_state IN ('UNCERTAIN','CONSUMED')) OR
   (signer_state IN ('REFUSED','EXPIRED_NEVER_CONTACTED') AND exposure_state='RELEASED')) AND
  ((exposure_state='CONSUMED' AND accounting_reference IS NOT NULL AND base_consumed IS NOT NULL AND priority_consumed IS NOT NULL AND rent_consumed IS NOT NULL AND
    base_consumed BETWEEN 0 AND base_requested AND priority_consumed BETWEEN 0 AND priority_requested AND rent_consumed BETWEEN 0 AND rent_requested) OR
   (exposure_state<>'CONSUMED' AND accounting_reference IS NULL AND base_consumed IS NULL AND priority_consumed IS NULL AND rent_consumed IS NULL))
);
CREATE OR REPLACE FUNCTION economic_finalization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finalizations cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-ARRAY['signer_state','exposure_state','result_artifact','artifact_reference','final_transaction_id','refusal_reference','base_consumed','priority_consumed','rent_consumed','accounting_reference','updated_at','version']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['signer_state','exposure_state','result_artifact','artifact_reference','final_transaction_id','refusal_reference','base_consumed','priority_consumed','rent_consumed','accounting_reference','updated_at','version']) THEN
    RAISE EXCEPTION 'finalization tuple, budget version and signer operation are immutable';
  END IF;
  IF NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'invalid finalization version'; END IF;
  IF OLD.signer_state='EXPIRED_NEVER_CONTACTED' THEN RAISE EXCEPTION 'expired never-contacted operation is permanently terminal'; END IF;
  IF OLD.signer_state IN ('REFUSED','RESULT_AVAILABLE') AND
    ROW(NEW.signer_state,NEW.result_artifact,NEW.artifact_reference,NEW.final_transaction_id,NEW.refusal_reference) IS DISTINCT FROM
    ROW(OLD.signer_state,OLD.result_artifact,OLD.artifact_reference,OLD.final_transaction_id,OLD.refusal_reference) THEN
    RAISE EXCEPTION 'authoritative signer result is immutable';
  END IF;
  IF NEW.signer_state<>OLD.signer_state AND NOT(
    (OLD.signer_state='NOT_CONTACTED' AND NEW.signer_state IN ('CONTACT_COMMITTED','EXPIRED_NEVER_CONTACTED')) OR
    (OLD.signer_state IN ('CONTACT_COMMITTED','RESULT_UNKNOWN') AND NEW.signer_state IN ('RESULT_UNKNOWN','REFUSED','RESULT_AVAILABLE'))
  ) THEN RAISE EXCEPTION 'invalid signer transition'; END IF;
  IF OLD.exposure_state IN ('RELEASED','CONSUMED') AND
    ROW(NEW.exposure_state,NEW.base_consumed,NEW.priority_consumed,NEW.rent_consumed,NEW.accounting_reference) IS DISTINCT FROM
    ROW(OLD.exposure_state,OLD.base_consumed,OLD.priority_consumed,OLD.rent_consumed,OLD.accounting_reference) THEN
    RAISE EXCEPTION 'terminal exposure is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION economic_finalization_initial_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signer_state<>'NOT_CONTACTED' OR NEW.exposure_state<>'RESERVED' OR NEW.version<>0 OR NEW.result_artifact IS NOT NULL OR
    NEW.artifact_reference IS NOT NULL OR NEW.final_transaction_id IS NOT NULL OR NEW.refusal_reference IS NOT NULL OR NEW.accounting_reference IS NOT NULL OR
    NEW.base_consumed IS NOT NULL OR NEW.priority_consumed IS NOT NULL OR NEW.rent_consumed IS NOT NULL THEN
    RAISE EXCEPTION 'finalization INSERT cannot manufacture terminal, contacted or realized authority';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_finalization_initial_state BEFORE INSERT ON economic_finalizations
  FOR EACH ROW EXECUTE FUNCTION economic_finalization_initial_state();

CREATE FUNCTION economic_operation_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signer_state='EXPIRED_NEVER_CONTACTED' THEN
    IF EXISTS(SELECT 1 FROM economic_signer_contact_authority WHERE finalization_id=NEW.finalization_id) OR
      EXISTS(SELECT 1 FROM economic_effect_evidence WHERE finalization_id=NEW.finalization_id) OR NOT EXISTS(
        SELECT 1 FROM economic_expiry_records WHERE finalization_id=NEW.finalization_id AND generation=NEW.generation AND exposure_id=NEW.exposure_id
          AND base_released=NEW.base_requested AND priority_released=NEW.priority_requested AND rent_released=NEW.rent_requested
      ) THEN RAISE EXCEPTION 'expiry lacks proof of never-contacted atomic release'; END IF;
  ELSIF NEW.signer_state<>'NOT_CONTACTED' AND NOT EXISTS(
    SELECT 1 FROM economic_signer_contact_authority WHERE finalization_id=NEW.finalization_id AND signer_operation_id=NEW.signer_operation_id AND tuple_digest=NEW.tuple_digest
  ) THEN RAISE EXCEPTION 'durable signer contact authority required'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER economic_operation_authority_guard AFTER INSERT OR UPDATE ON economic_finalizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economic_operation_authority_guard();

-- Internal helper. PUBLIC execute is revoked below. Fixed search path and fully qualified objects avoid shadowing.
CREATE FUNCTION economic_lock_operation(p_id uuid) RETURNS economic_finalizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; family text;
BEGIN
  SELECT * INTO f FROM public.economic_finalizations WHERE finalization_id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown finalization'; END IF;
  PERFORM 1 FROM public.economic_attempt_heads WHERE intent_id=f.intent_id FOR UPDATE;
  SELECT family_id INTO family FROM public.economic_budget_versions WHERE budget_id=f.budget_id;
  PERFORM 1 FROM public.economic_budget_heads WHERE family_id=family FOR UPDATE;
  PERFORM 1 FROM public.economic_sponsor_budgets WHERE budget_id=f.budget_id FOR UPDATE;
  SELECT * INTO f FROM public.economic_finalizations WHERE finalization_id=p_id FOR UPDATE;
  RETURN f;
END;
$$;

-- One evidence snapshot under locks, shared by contact and expiry. No inferred revocation from a missing session.
CREATE FUNCTION economic_locked_invalidation_reasons(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; a public.economic_attempts%ROWTYPE;
  c public.economic_consent_evidence%ROWTYPE; r public.economic_runtime_evidence%ROWTYPE;
  s public.account_sessions%ROWTYPE; ac public.accounts%ROWTYPE; asset record; n record; reasons jsonb:='[]'; now_at timestamptz;
BEGIN
  SELECT * INTO f FROM public.economic_finalizations WHERE finalization_id=p_id;
  SELECT * INTO a FROM public.economic_attempts WHERE intent_id=f.intent_id AND generation=f.generation;
  SELECT * INTO ac FROM public.accounts WHERE actor_subject=a.envelope->'principal'->>'id' FOR SHARE;
  SELECT * INTO c FROM public.economic_consent_evidence WHERE consent_id=f.consent_id FOR SHARE;
  SELECT * INTO r FROM public.economic_runtime_evidence WHERE decision_id=f.runtime_id FOR SHARE;
  IF c.account_session_id IS NOT NULL THEN SELECT * INTO s FROM public.account_sessions WHERE session_id=c.account_session_id FOR SHARE; END IF;
  -- Consistent registry order. Registry/account/evidence revocation transactions never lock an operation/head.
  FOR n IN SELECT nr.* FROM public.economic_network_registry nr WHERE nr.registry_id IN
    (SELECT network_id FROM public.economic_asset_registry WHERE registry_id IN (f.payment_registry_id,f.fee_registry_id)) ORDER BY nr.registry_id FOR SHARE LOOP
    IF n.revoked_at IS NOT NULL THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','NETWORK_REVOKED','reference',n.registry_id)); END IF;
  END LOOP;
  FOR asset IN SELECT * FROM public.economic_asset_registry WHERE registry_id IN (f.payment_registry_id,f.fee_registry_id) ORDER BY registry_id FOR SHARE LOOP
    IF asset.revoked_at IS NOT NULL THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','ASSET_REVOKED','reference',asset.registry_id)); END IF;
  END LOOP;
  now_at:=clock_timestamp();
  IF (a.envelope->>'expiresAt')::timestamptz<=now_at THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','INTENT_EXPIRED','reference',a.envelope_digest)); END IF;
  IF ac.status<>'ACTIVE' THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','ACCOUNT_INACTIVE','reference',ac.account_id)); END IF;
  IF c.revoked_at IS NOT NULL THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','CONSENT_REVOKED','reference',c.consent_id)); END IF;
  IF c.expires_at<=now_at THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','CONSENT_EXPIRED','reference',c.consent_id)); END IF;
  IF r.revoked_at IS NOT NULL THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','RUNTIME_REVOKED','reference',r.decision_id)); END IF;
  IF r.valid_until<=now_at THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','RUNTIME_EXPIRED','reference',r.decision_id)); END IF;
  IF s.revoked_at IS NOT NULL THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','SESSION_REVOKED','reference',s.session_id)); END IF;
  IF s.expires_at<=now_at THEN reasons:=reasons||jsonb_build_array(jsonb_build_object('reason','SESSION_EXPIRED','reference',s.session_id)); END IF;
  RETURN reasons;
END;
$$;

CREATE FUNCTION economic_commit_signer_contact(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; a public.economic_attempts%ROWTYPE; c public.economic_consent_evidence%ROWTYPE; s public.account_sessions%ROWTYPE;
BEGIN
  f:=public.economic_lock_operation(p_id);
  IF f.signer_state<>'NOT_CONTACTED' THEN RETURN false; END IF;
  SELECT * INTO a FROM public.economic_attempts WHERE intent_id=f.intent_id AND generation=f.generation;
  IF a.state<>'FINALIZATION_COMMITTED' OR a.finalization_id<>p_id OR NOT EXISTS(
    SELECT 1 FROM public.economic_attempt_heads WHERE intent_id=f.intent_id AND current_generation=f.generation
  ) THEN RAISE EXCEPTION 'signer contact canonical fence mismatch'; END IF;
  IF jsonb_array_length(public.economic_locked_invalidation_reasons(p_id))>0 THEN RAISE EXCEPTION 'expired or revoked first-contact authority'; END IF;
  SELECT * INTO c FROM public.economic_consent_evidence WHERE consent_id=f.consent_id;
  SELECT * INTO s FROM public.account_sessions WHERE session_id=c.account_session_id;
  IF c.account_session_id IS NULL OR s.session_id IS NULL OR s.created_at>clock_timestamp() OR
    'zp:account:'||s.account_id::text<>c.principal_id THEN RAISE EXCEPTION 'authoritative bound session required for first contact'; END IF;
  IF EXISTS(SELECT 1 FROM public.economic_signer_contact_authority WHERE finalization_id=p_id) OR
    EXISTS(SELECT 1 FROM public.economic_effect_evidence WHERE finalization_id=p_id) OR
    EXISTS(SELECT 1 FROM public.economic_callback_evidence WHERE intent_id=f.intent_id AND generation=f.generation AND validation IN ('REJECTED','SPONSOR_RESULT_PRESENT')) THEN RAISE EXCEPTION 'contradictory prior contact/effect evidence'; END IF;
  INSERT INTO public.economic_signer_contact_authority(finalization_id,signer_operation_id,tuple_digest,origin)
    VALUES(p_id,f.signer_operation_id,f.tuple_digest,'CONTACT_COMMIT');
  UPDATE public.economic_finalizations SET signer_state='CONTACT_COMMITTED',exposure_state='UNCERTAIN',updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=p_id;
  INSERT INTO public.economic_authority_events(event_type,actor,intent_id,generation,finalization_id,reference)
    VALUES('SIGNER_CONTACT_COMMITTED','signer-coordinator',f.intent_id,f.generation,p_id,f.signer_operation_id::text);
  RETURN true;
END;
$$;

CREATE FUNCTION economic_expire_never_contacted(p_id uuid,p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; a public.economic_attempts%ROWTYPE; c public.economic_consent_evidence%ROWTYPE; reasons jsonb;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 192 THEN RAISE EXCEPTION 'expiry system actor required'; END IF;
  f:=public.economic_lock_operation(p_id);
  IF f.signer_state='EXPIRED_NEVER_CONTACTED' THEN RETURN; END IF;
  IF f.signer_state<>'NOT_CONTACTED' OR f.exposure_state<>'RESERVED' OR f.result_artifact IS NOT NULL OR f.refusal_reference IS NOT NULL OR
    f.accounting_reference IS NOT NULL OR f.base_consumed IS NOT NULL OR f.priority_consumed IS NOT NULL OR f.rent_consumed IS NOT NULL THEN
    RAISE EXCEPTION 'contacted, uncertain, realized or terminal operation cannot be reclaimed';
  END IF;
  SELECT * INTO a FROM public.economic_attempts WHERE intent_id=f.intent_id AND generation=f.generation;
  IF a.state<>'FINALIZATION_COMMITTED' OR a.finalization_id<>p_id OR NOT EXISTS(
    SELECT 1 FROM public.economic_attempt_heads WHERE intent_id=f.intent_id AND current_generation=f.generation
  ) THEN RAISE EXCEPTION 'expiry canonical generation/fence mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM public.economic_signer_contact_authority WHERE finalization_id=p_id) OR
    EXISTS(SELECT 1 FROM public.economic_effect_evidence WHERE finalization_id=p_id) OR
    EXISTS(SELECT 1 FROM public.economic_callback_evidence WHERE intent_id=f.intent_id AND generation=f.generation AND validation IN ('REJECTED','SPONSOR_RESULT_PRESENT')) OR
    EXISTS(SELECT 1 FROM public.economic_authority_events WHERE finalization_id=p_id AND event_type IN
      ('SIGNER_CONTACT_COMMITTED','SIGNER_RESULT_UNKNOWN','SIGNER_RESULT_VERIFIED','SIGNER_REFUSED_EXPOSURE_RELEASED','EXPOSURE_CONSUMED')) THEN
    RAISE EXCEPTION 'contradictory contact, submission or observer evidence prevents reclamation';
  END IF;
  reasons:=public.economic_locked_invalidation_reasons(p_id);
  IF jsonb_array_length(reasons)=0 THEN RAISE EXCEPTION 'operation is not authoritatively expired or revoked'; END IF;
  SELECT * INTO c FROM public.economic_consent_evidence WHERE consent_id=f.consent_id;
  INSERT INTO public.economic_expiry_records(finalization_id,generation,exposure_id,old_state,new_state,reasons,consent_id,runtime_id,account_session_id,base_released,priority_released,rent_released,actor)
    VALUES(p_id,f.generation,f.exposure_id,'NOT_CONTACTED','EXPIRED_NEVER_CONTACTED',reasons,f.consent_id,f.runtime_id,c.account_session_id,f.base_requested,f.priority_requested,f.rent_requested,p_actor);
  UPDATE public.economic_finalizations SET signer_state='EXPIRED_NEVER_CONTACTED',exposure_state='RELEASED',updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=p_id;
  INSERT INTO public.economic_authority_events(event_type,actor,intent_id,generation,finalization_id,consent_id,runtime_id,reference)
    VALUES('EXPIRED_NEVER_CONTACTED',p_actor,f.intent_id,f.generation,p_id,f.consent_id,f.runtime_id,f.exposure_id::text);
END;
$$;

CREATE FUNCTION economic_record_signer_unknown(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE;
BEGIN
  f:=public.economic_lock_operation(p_id);
  IF f.signer_state IN ('REFUSED','RESULT_AVAILABLE') THEN RETURN; END IF;
  IF f.signer_state NOT IN ('CONTACT_COMMITTED','RESULT_UNKNOWN') THEN RAISE EXCEPTION 'no contact authority to recover'; END IF;
  UPDATE public.economic_finalizations SET signer_state='RESULT_UNKNOWN',exposure_state='UNCERTAIN',updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=p_id;
  INSERT INTO public.economic_authority_events(event_type,actor,intent_id,generation,finalization_id,reference)
    VALUES('SIGNER_RESULT_UNKNOWN','signer-coordinator',f.intent_id,f.generation,p_id,f.exposure_id::text);
END;
$$;

CREATE FUNCTION economic_effect_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE;
BEGIN
  f:=public.economic_lock_operation(NEW.finalization_id);
  IF f.signer_state='EXPIRED_NEVER_CONTACTED' OR NEW.network<>f.tuple->'network' THEN RAISE EXCEPTION 'effect conflicts with terminal expiry or network'; END IF;
  IF NEW.kind='FINALIZED_ACCOUNTING' AND (f.signer_state<>'RESULT_AVAILABLE' OR NEW.transaction_id<>f.final_transaction_id OR
    NEW.base_consumed>f.base_requested OR NEW.priority_consumed>f.priority_requested OR NEW.rent_consumed>f.rent_requested) THEN
    RAISE EXCEPTION 'finalized evidence requires exact signed result and bounded accounting';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER economic_effect_evidence_guard BEFORE INSERT ON economic_effect_evidence
  FOR EACH ROW EXECUTE FUNCTION economic_effect_evidence_guard();
CREATE FUNCTION economic_apply_finalized_accounting(p_id uuid,p_evidence uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; e public.economic_effect_evidence%ROWTYPE;
BEGIN
  f:=public.economic_lock_operation(p_id);
  SELECT * INTO e FROM public.economic_effect_evidence WHERE evidence_id=p_evidence AND finalization_id=p_id AND kind='FINALIZED_ACCOUNTING';
  IF NOT FOUND OR f.signer_state<>'RESULT_AVAILABLE' OR e.transaction_id<>f.final_transaction_id OR e.network<>f.tuple->'network' THEN RAISE EXCEPTION 'trusted finalized evidence required'; END IF;
  IF f.exposure_state='CONSUMED' THEN
    IF f.accounting_reference<>e.reference OR f.base_consumed<>e.base_consumed OR f.priority_consumed<>e.priority_consumed OR f.rent_consumed<>e.rent_consumed THEN RAISE EXCEPTION 'conflicting immutable accounting'; END IF;
    RETURN;
  END IF;
  UPDATE public.economic_finalizations SET exposure_state='CONSUMED',base_consumed=e.base_consumed,priority_consumed=e.priority_consumed,rent_consumed=e.rent_consumed,accounting_reference=e.reference,updated_at=clock_timestamp(),version=version+1 WHERE finalization_id=p_id;
  INSERT INTO public.economic_authority_events(event_type,actor,intent_id,generation,finalization_id,reference)
    VALUES('EXPOSURE_CONSUMED','trusted-finalized-observer',f.intent_id,f.generation,p_id,e.reference);
END;
$$;

CREATE VIEW economic_observer_operations AS SELECT finalization_id,tuple->'network' AS network,tuple_digest,signer_state,final_transaction_id,base_requested,priority_requested,rent_requested FROM economic_finalizations;
REVOKE ALL ON FUNCTION economic_lock_operation(uuid),economic_locked_invalidation_reasons(uuid),economic_commit_signer_contact(uuid),economic_expire_never_contacted(uuid,text),economic_record_signer_unknown(uuid),economic_apply_finalized_accounting(uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION economic_budget_capacity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  b economic_sponsor_budgets%ROWTYPE; h economic_budget_heads%ROWTYPE;
  total_base numeric; total_priority numeric; total_rent numeric; outstanding bigint;
BEGIN
  SELECT heads.* INTO h FROM economic_budget_heads heads JOIN economic_budget_versions v USING(family_id) WHERE v.budget_id=NEW.budget_id FOR UPDATE OF heads;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing budget family'; END IF;
  SELECT * INTO b FROM economic_sponsor_budgets WHERE budget_id=NEW.budget_id FOR UPDATE;
  IF TG_OP='INSERT' AND (h.status<>'ACTIVE' OR h.current_budget_id<>NEW.budget_id) THEN RAISE EXCEPTION 'budget disabled or obsolete version'; END IF;
  IF b.network <> NEW.tuple->'network' OR b.sponsor_public_key <> NEW.tuple->>'sponsorPublicKey' OR
    b.sponsor_key_version <> NEW.tuple->>'sponsorKeyVersion' THEN
    RAISE EXCEPTION 'reservation sponsor/network budget mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM economic_attempts a
    JOIN economic_consent_evidence c ON c.consent_id=NEW.consent_id
    JOIN economic_runtime_evidence r ON r.decision_id=NEW.runtime_id
    JOIN economic_asset_registry p ON p.registry_id=NEW.payment_registry_id
    JOIN economic_asset_registry f ON f.registry_id=NEW.fee_registry_id
    WHERE a.intent_id=NEW.intent_id AND a.generation=NEW.generation
      AND a.requested_exposure_id=NEW.exposure_id
      AND (a.envelope->'fee'->>'maxBaseFee')::numeric=NEW.base_requested
      AND (a.envelope->'fee'->>'maxPriorityFee')::numeric=NEW.priority_requested
      AND (a.envelope->'fee'->>'maxRent')::numeric=NEW.rent_requested
      AND p.identity=a.envelope->'amount'->'asset' AND p.use_role='PAYMENT'
      AND f.identity=a.envelope->'fee'->'asset' AND f.use_role='FEE'
      AND c.envelope_digest=a.envelope_digest AND c.principal_id=a.envelope->'principal'->>'id'
      AND r.envelope_digest=a.envelope_digest AND r.network=NEW.tuple->'network'
      AND r.binding->'reference'=NEW.tuple->'runtime' AND r.binding->>'result'='approved'
      AND r.binding->>'envelopeDigest'=a.envelope_digest
  ) THEN RAISE EXCEPTION 'reservation/evidence/registry binding mismatch'; END IF;
  SELECT
    COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN base_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN base_requested ELSE 0 END),0),
    COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN priority_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN priority_requested ELSE 0 END),0),
    COALESCE(sum(CASE WHEN exposure_state='CONSUMED' THEN rent_consumed WHEN exposure_state IN ('RESERVED','UNCERTAIN') THEN rent_requested ELSE 0 END),0),
    count(*) FILTER (WHERE exposure_state IN ('RESERVED','UNCERTAIN'))
    INTO total_base,total_priority,total_rent,outstanding FROM economic_finalizations WHERE budget_id=NEW.budget_id;
  IF total_base>b.base_limit OR total_priority>b.priority_limit OR total_rent>b.rent_limit OR outstanding>b.outstanding_limit THEN
    RAISE EXCEPTION 'durable sponsor exposure capacity exceeded';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT
      COALESCE(sum(CASE WHEN f.exposure_state='CONSUMED' THEN f.base_consumed WHEN f.exposure_state IN ('RESERVED','UNCERTAIN') THEN f.base_requested ELSE 0 END),0),
      COALESCE(sum(CASE WHEN f.exposure_state='CONSUMED' THEN f.priority_consumed WHEN f.exposure_state IN ('RESERVED','UNCERTAIN') THEN f.priority_requested ELSE 0 END),0),
      COALESCE(sum(CASE WHEN f.exposure_state='CONSUMED' THEN f.rent_consumed WHEN f.exposure_state IN ('RESERVED','UNCERTAIN') THEN f.rent_requested ELSE 0 END),0),
      count(*) FILTER(WHERE f.exposure_state IN ('RESERVED','UNCERTAIN')) INTO total_base,total_priority,total_rent,outstanding
      FROM economic_finalizations f JOIN economic_budget_versions v USING(budget_id) WHERE v.family_id=h.family_id;
    IF total_base>b.base_limit OR total_priority>b.priority_limit OR total_rent>b.rent_limit OR outstanding>b.outstanding_limit THEN RAISE EXCEPTION 'budget family capacity exceeded across versions'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION economic_session_binding_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_consent_session_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_budget_head_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_budget_version_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_finalization_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_finalization_initial_state() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_operation_authority_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_finalization_consistency() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION economic_attempt_finalization_consistency() SET search_path=pg_catalog,public,pg_temp;
