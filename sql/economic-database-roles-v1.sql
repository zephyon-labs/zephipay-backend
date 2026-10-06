-- Explicit privileged deployment contract. No passwords/logins, runtime wiring or live defaults.
-- Requires role administration plus ownership of the listed foundation objects and schema.
BEGIN;
SELECT pg_advisory_xact_lock(827346192045711002);
DO $$ DECLARE role_name text; r record; BEGIN
  IF NOT EXISTS(SELECT 1 FROM payment_schema_migrations WHERE version='030_confirmation_sdk_transactions.sql') THEN
    RAISE EXCEPTION 'migration 030 required before role provisioning';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['zephipay_economic_admin','zephipay_economic_app','zephipay_economic_issuer','zephipay_economic_signer','zephipay_economic_observer','zephipay_economic_reader','zephipay_economic_identity'] LOOP
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
GRANT USAGE ON SCHEMA public TO zephipay_economic_admin,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader,zephipay_economic_identity;
GRANT CREATE ON SCHEMA public TO zephipay_economic_admin;
DO $$ DECLARE name text; f record; BEGIN
  FOREACH name IN ARRAY ARRAY['economic_confirmation_sdk_transactions','economic_confirmation_sdk_callbacks','economic_confirmation_policy_rules','economic_confirmation_proofs','economic_confirmation_admissions','economic_confirmation_policies','economic_confirmation_policy_heads','economic_confirmation_challenges','economic_confirmation_consumptions','economic_confirmation_summary','economic_deployment_identity','economic_deployment_logins','economic_provider_token_uses','economic_network_registry','economic_asset_registry','economic_attempt_heads','economic_attempts',
    'economic_consent_evidence','economic_runtime_evidence','economic_sponsor_budgets','economic_finalizations','economic_authority_events',
    'economic_callback_evidence','economic_exposure_projection','economic_session_bindings','economic_budget_heads','economic_budget_versions',
    'economic_signer_contact_authority','economic_expiry_records','economic_effect_evidence','economic_observer_operations',
    'economic_observer_report_summary','economic_authority_incidents','economic_observer_reports','economic_authority_trace','economic_signer_reports','economic_signer_report_summary'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO zephipay_economic_admin',name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader,zephipay_economic_identity',name);
    -- REVOKE table privileges does not revoke previously granted column privileges.
    FOR f IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',name)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON public.%I FROM PUBLIC,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader,zephipay_economic_identity',f.attname,name);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY(ARRAY['economic_confirmation_sdk_context','economic_bind_confirmation_sdk','economic_read_confirmation_sdk','economic_record_confirmation_sdk_callback','economic_confirmation_sdk_proof_guard','economic_confirmation_sdk_admission_guard','economic_confirmation_root_write','economic_confirmation_caller','economic_confirmation_context','economic_confirmation_issued','economic_issue_confirmation','economic_record_confirmation_proof','economic_admit_confirmation','economic_confirmation_policy_guard','economic_revocation_only','economic_attempt_guard','economic_head_guard',
      'economic_finalization_guard','economic_finalization_consistency','economic_attempt_finalization_consistency','economic_budget_capacity',
      'economic_callback_authority_guard','economic_session_binding_guard','economic_consent_session_guard','economic_budget_head_guard','economic_budget_version_guard',
      'economic_finalization_initial_state','economic_operation_authority_guard','economic_lock_operation','economic_locked_invalidation_reasons',
      'economic_record_signer_conflict','economic_contact_session_chronology','economic_record_incident','economic_incident_freeze_guard','economic_ingest_observation',
      'economic_commit_signer_contact','economic_expire_never_contacted','economic_record_signer_unknown','economic_effect_evidence_guard','economic_apply_finalized_accounting']) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO zephipay_economic_admin',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader,zephipay_economic_identity',f.signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,public,pg_temp',f.signature);
  END LOOP;
END; $$;
GRANT SELECT ON economic_signer_reports TO zephipay_economic_signer;
GRANT SELECT ON economic_signer_report_summary TO zephipay_economic_reader;
GRANT EXECUTE ON FUNCTION economic_record_signer_conflict(uuid,jsonb,bytea) TO zephipay_economic_signer;
GRANT SELECT ON account_security_events TO zephipay_economic_admin;
GRANT SELECT ON economic_authority_incidents TO zephipay_economic_app,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader;
GRANT SELECT ON economic_observer_reports TO zephipay_economic_observer;
GRANT SELECT ON economic_observer_report_summary TO zephipay_economic_app,zephipay_economic_reader;
GRANT SELECT ON economic_authority_trace TO zephipay_economic_app,zephipay_economic_reader;
GRANT EXECUTE ON FUNCTION economic_record_incident(uuid,text,text) TO zephipay_economic_app,zephipay_economic_signer,zephipay_economic_observer;
GRANT EXECUTE ON FUNCTION economic_ingest_observation(uuid,text,jsonb) TO zephipay_economic_observer;
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
GRANT SELECT ON economic_deployment_identity,economic_deployment_logins TO zephipay_economic_identity,zephipay_economic_app,zephipay_economic_issuer,zephipay_economic_signer,zephipay_economic_observer,zephipay_economic_reader;
GRANT SELECT,INSERT ON economic_provider_token_uses TO zephipay_economic_identity,zephipay_economic_issuer;
-- Identity service uses the existing canonical lifecycle, CAS and security-event transactions.
GRANT SELECT,INSERT ON accounts,external_identities,account_sessions,account_security_events TO zephipay_economic_identity;
GRANT UPDATE(status,version,updated_at) ON accounts TO zephipay_economic_identity;
GRANT UPDATE(revoked_at) ON account_sessions TO zephipay_economic_identity;
GRANT SELECT ON economic_session_bindings TO zephipay_economic_identity;
GRANT INSERT(issuer,provider_subject,provider_session_reference,account_session_id) ON economic_session_bindings TO zephipay_economic_identity;
GRANT INSERT(event_type,actor,intent_id,generation,finalization_id,consent_id,runtime_id,reference) ON economic_authority_events TO zephipay_economic_identity;
GRANT USAGE ON SEQUENCE account_security_events_event_id_seq,economic_authority_events_event_id_seq TO zephipay_economic_identity;
-- Confirmation mutations require guarded operations; identity attestation and issuer admission remain separate.
GRANT SELECT ON economic_confirmation_policies,economic_confirmation_policy_heads,economic_confirmation_challenges,
  economic_confirmation_consumptions,economic_confirmation_summary,economic_attempt_heads TO zephipay_economic_issuer;
GRANT UPDATE(deployment_id) ON economic_confirmation_policy_heads TO zephipay_economic_issuer;
GRANT UPDATE(singleton) ON economic_deployment_identity TO zephipay_economic_issuer;
GRANT UPDATE(intent_id) ON economic_attempt_heads TO zephipay_economic_issuer;
GRANT EXECUTE ON FUNCTION economic_issue_confirmation(uuid,uuid,text,jsonb),economic_admit_confirmation(uuid,uuid,uuid,text,uuid,text) TO zephipay_economic_issuer;
GRANT EXECUTE ON FUNCTION economic_bind_confirmation_sdk(uuid,uuid,jsonb,jsonb),economic_read_confirmation_sdk(uuid,jsonb),economic_record_confirmation_sdk_callback(uuid,jsonb,jsonb),economic_record_confirmation_proof(uuid,jsonb) TO zephipay_economic_identity;
GRANT SELECT ON economic_confirmation_summary TO zephipay_economic_reader;
COMMIT;
