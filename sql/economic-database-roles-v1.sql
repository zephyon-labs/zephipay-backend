-- Explicit privileged deployment contract. No passwords/logins, runtime wiring or live defaults.
-- Requires role administration plus ownership of the listed foundation objects and schema.
BEGIN;
SELECT pg_advisory_xact_lock(827346192045711002);
DO $$ DECLARE role_name text; r record; BEGIN
  IF NOT EXISTS(SELECT 1 FROM payment_schema_migrations WHERE version='024_pre_signer_operational_authority.sql') THEN
    RAISE EXCEPTION 'migration 024 required before role provisioning';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['zephipay_economic_admin','zephipay_economic_app','zephipay_economic_issuer','zephipay_economic_signer','zephipay_economic_observer','zephipay_economic_reader'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    END IF;
    SELECT * INTO r FROM pg_roles WHERE rolname=role_name;
    IF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) THEN
      RAISE EXCEPTION 'economic group role has unexpected attributes or inherited authority: %',role_name;
    END IF;
  END LOOP;
END; $$;
-- Definer functions use a pinned search path. PUBLIC must not create objects in that path.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO zephipay_economic_admin,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader;
GRANT CREATE ON SCHEMA public TO zephipay_economic_admin;
DO $$ DECLARE name text; f record; BEGIN
  FOREACH name IN ARRAY ARRAY['economic_network_registry','economic_asset_registry','economic_attempt_heads','economic_attempts',
    'economic_consent_evidence','economic_runtime_evidence','economic_sponsor_budgets','economic_finalizations','economic_authority_events',
    'economic_callback_evidence','economic_exposure_projection','economic_session_bindings','economic_budget_heads','economic_budget_versions',
    'economic_signer_contact_authority','economic_expiry_records','economic_effect_evidence','economic_observer_operations'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO zephipay_economic_admin',name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader',name);
    -- REVOKE table privileges does not revoke previously granted column privileges.
    FOR f IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',name)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON public.%I FROM PUBLIC,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader',f.attname,name);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY(ARRAY['economic_revocation_only','economic_attempt_guard','economic_head_guard',
      'economic_finalization_guard','economic_finalization_consistency','economic_attempt_finalization_consistency','economic_budget_capacity',
      'economic_callback_authority_guard','economic_session_binding_guard','economic_consent_session_guard','economic_budget_head_guard','economic_budget_version_guard',
      'economic_finalization_initial_state','economic_operation_authority_guard','economic_lock_operation','economic_locked_invalidation_reasons',
      'economic_commit_signer_contact','economic_expire_never_contacted','economic_record_signer_unknown','economic_effect_evidence_guard','economic_apply_finalized_accounting']) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO zephipay_economic_admin',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader',f.signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,public,pg_temp',f.signature);
  END LOOP;
END; $$;
GRANT SELECT ON accounts,account_sessions,external_identities TO zephipay_economic_admin,zephipay_economic_app,zephipay_economic_issuer;
-- Lock-only immutable columns: PostgreSQL row locks need an UPDATE privilege. Existing guards forbid actual edits.
GRANT UPDATE(account_id) ON accounts TO zephipay_economic_admin,zephipay_economic_app,zephipay_economic_issuer;
GRANT UPDATE(session_id) ON account_sessions TO zephipay_economic_admin,zephipay_economic_app,zephipay_economic_issuer;
GRANT SELECT ON economic_network_registry,economic_asset_registry,economic_attempt_heads,economic_attempts,economic_consent_evidence,
  economic_runtime_evidence,economic_sponsor_budgets,economic_finalizations,economic_authority_events,economic_callback_evidence,economic_session_bindings,
  economic_budget_heads,economic_budget_versions,economic_signer_contact_authority,economic_expiry_records,economic_effect_evidence,economic_exposure_projection
  TO zephipay_economic_app,zephipay_economic_signer;
GRANT UPDATE(registry_id) ON economic_network_registry,economic_asset_registry TO zephipay_economic_app,zephipay_economic_issuer;
GRANT UPDATE(consent_id) ON economic_consent_evidence TO zephipay_economic_app;
GRANT UPDATE(decision_id) ON economic_runtime_evidence TO zephipay_economic_app;
GRANT UPDATE(budget_id) ON economic_sponsor_budgets TO zephipay_economic_app,zephipay_economic_signer;
GRANT UPDATE(family_id) ON economic_budget_heads TO zephipay_economic_app,zephipay_economic_signer;
GRANT UPDATE(finalization_id) ON economic_finalizations TO zephipay_economic_app;
GRANT UPDATE(intent_id) ON economic_attempt_heads TO zephipay_economic_signer;
GRANT INSERT(intent_id,principal_id,current_generation),UPDATE(current_generation) ON economic_attempt_heads TO zephipay_economic_app;
GRANT INSERT(intent_id,generation,attempt_id,fence_token,envelope_digest,envelope,message_digest,recent_blockhash,requested_exposure_id),UPDATE(state,finalization_id)
  ON economic_attempts TO zephipay_economic_app;
GRANT INSERT(finalization_id,intent_id,generation,tuple,tuple_digest,consent_id,runtime_id,payment_registry_id,fee_registry_id,budget_id,budget_version,
  exposure_id,base_requested,priority_requested,rent_requested,signer_operation_id,customer_artifact) ON economic_finalizations TO zephipay_economic_app;
GRANT INSERT(evidence_id,intent_id,generation,artifact_digest,artifact,validation) ON economic_callback_evidence TO zephipay_economic_app;
GRANT EXECUTE ON FUNCTION economic_commit_signer_contact(uuid),economic_expire_never_contacted(uuid,text),economic_record_signer_unknown(uuid),economic_apply_finalized_accounting(uuid,uuid)
  TO zephipay_economic_app;
GRANT UPDATE(signer_state,exposure_state,result_artifact,artifact_reference,final_transaction_id,refusal_reference,updated_at,version)
  ON economic_finalizations TO zephipay_economic_signer;
GRANT SELECT ON economic_network_registry,economic_asset_registry,economic_attempts,economic_consent_evidence,economic_runtime_evidence,economic_session_bindings TO zephipay_economic_issuer;
GRANT INSERT(issuer,provider_subject,provider_session_reference,account_session_id) ON economic_session_bindings TO zephipay_economic_issuer;
GRANT INSERT(consent_id,envelope_digest,principal_id,issuer,audience,context,provider_subject,authentication_reference,session_reference,authenticated_at,confirmed_at,expires_at,account_session_id),UPDATE(revoked_at)
  ON economic_consent_evidence TO zephipay_economic_issuer;
GRANT INSERT(decision_id,envelope_digest,issuer,policy_version,evidence_digest,binding,network,scope,valid_from,valid_until),UPDATE(revoked_at)
  ON economic_runtime_evidence TO zephipay_economic_issuer;
GRANT SELECT ON economic_observer_operations,economic_effect_evidence TO zephipay_economic_observer;
GRANT INSERT(evidence_id,finalization_id,kind,network,transaction_id,reference,base_consumed,priority_consumed,rent_consumed) ON economic_effect_evidence TO zephipay_economic_observer;
GRANT SELECT ON economic_observer_operations,economic_exposure_projection,economic_expiry_records,economic_authority_events,economic_network_registry,economic_asset_registry,
  economic_sponsor_budgets,economic_budget_heads,economic_budget_versions TO zephipay_economic_reader;
GRANT INSERT(event_type,actor,intent_id,generation,finalization_id,consent_id,runtime_id,reference) ON economic_authority_events TO zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer;
REVOKE ALL ON SEQUENCE economic_authority_events_event_id_seq FROM PUBLIC;
GRANT USAGE ON SEQUENCE economic_authority_events_event_id_seq TO zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer;
COMMIT;
