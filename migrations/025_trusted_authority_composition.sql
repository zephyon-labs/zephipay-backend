-- PA-01: equality on finalization_id plus a bounded event_type IN predicate.
CREATE INDEX economic_authority_events_finalization_type_idx ON economic_authority_events(finalization_id,event_type);

-- Issuer-asserted token issuance must not predate the canonical session it is authorizing.
-- Historical consent is unchanged; the contact guard also checks old rows at the authority boundary.
CREATE OR REPLACE FUNCTION economic_consent_session_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s account_sessions%ROWTYPE;
BEGIN
  IF NEW.account_session_id IS NULL OR NEW.session_reference IS NULL THEN RAISE EXCEPTION 'authoritative account session required'; END IF;
  PERFORM 1 FROM accounts WHERE actor_subject=NEW.principal_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inactive consent principal'; END IF;
  SELECT * INTO s FROM account_sessions WHERE session_id=NEW.account_session_id FOR SHARE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.created_at>clock_timestamp() OR
    'zp:account:'||s.account_id::text<>NEW.principal_id OR NEW.expires_at>s.expires_at OR NEW.authenticated_at<s.created_at THEN
    RAISE EXCEPTION 'invalid session or authentication predates canonical session';
  END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION economic_contact_session_chronology() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.origin='CONTACT_COMMIT' AND NOT EXISTS(SELECT 1 FROM economic_finalizations f
    JOIN economic_consent_evidence c USING(consent_id) JOIN account_sessions s ON s.session_id=c.account_session_id
    WHERE f.finalization_id=NEW.finalization_id AND c.authenticated_at>=s.created_at) THEN
    RAISE EXCEPTION 'authentication predates or lacks canonical session';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_contact_session_chronology BEFORE INSERT ON economic_signer_contact_authority
  FOR EACH ROW EXECUTE FUNCTION economic_contact_session_chronology();

CREATE TABLE economic_authority_incidents (
  incident_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finalization_id uuid NOT NULL REFERENCES economic_finalizations,
  kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 192),
  status text NOT NULL DEFAULT 'MANUAL_REVIEW_REQUIRED' CHECK(status='MANUAL_REVIEW_REQUIRED'),
  database_actor text NOT NULL DEFAULT session_user,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(finalization_id,kind,reference)
);
CREATE TRIGGER economic_incidents_immutable BEFORE UPDATE OR DELETE ON economic_authority_incidents
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE FUNCTION economic_record_incident(p_id uuid,p_kind text,p_reference text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; result_id uuid;
BEGIN
  f:=public.economic_lock_operation(p_id);
  INSERT INTO public.economic_authority_incidents(finalization_id,kind,reference) VALUES(p_id,p_kind,p_reference)
    ON CONFLICT(finalization_id,kind,reference) DO NOTHING RETURNING incident_id INTO result_id;
  IF result_id IS NOT NULL THEN
    INSERT INTO public.economic_authority_events(event_type,actor,intent_id,generation,finalization_id,reference)
      VALUES('AUTHORITY_INCIDENT','restricted-authority-monitor',f.intent_id,f.generation,p_id,result_id::text);
  ELSE SELECT incident_id INTO result_id FROM public.economic_authority_incidents WHERE finalization_id=p_id AND kind=p_kind AND reference=p_reference; END IF;
  RETURN result_id;
END; $$;
CREATE FUNCTION economic_incident_freeze_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF (NEW.signer_state IN ('CONTACT_COMMITTED','EXPIRED_NEVER_CONTACTED','REFUSED') OR NEW.exposure_state='CONSUMED')
    AND EXISTS(SELECT 1 FROM economic_authority_incidents WHERE finalization_id=NEW.finalization_id) THEN
    RAISE EXCEPTION 'economic authority frozen for manual review';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER economic_incident_freeze_guard BEFORE UPDATE ON economic_finalizations
  FOR EACH ROW EXECUTE FUNCTION economic_incident_freeze_guard();

CREATE TABLE economic_signer_reports (
  report_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),finalization_id uuid NOT NULL REFERENCES economic_finalizations,
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND octet_length(report::text)<=4096),
  report_digest text NOT NULL CHECK(report_digest~'^[a-f0-9]{64}$'),
  artifact bytea CHECK(octet_length(artifact)<=1232),
  database_actor text NOT NULL DEFAULT session_user,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(finalization_id,report_digest)
);
CREATE TRIGGER economic_signer_reports_immutable BEFORE UPDATE OR DELETE ON economic_signer_reports
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE FUNCTION economic_record_signer_conflict(p_id uuid,p_report jsonb,p_artifact bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; d text; stored_id uuid;
BEGIN
  f:=public.economic_lock_operation(p_id);d:=encode(public.digest(p_report::text,'sha256'),'hex');
  INSERT INTO public.economic_signer_reports(finalization_id,report,report_digest,artifact) VALUES(p_id,p_report,d,p_artifact)
    ON CONFLICT(finalization_id,report_digest) DO NOTHING RETURNING report_id INTO stored_id;
  IF stored_id IS NULL THEN SELECT report_id INTO stored_id FROM public.economic_signer_reports WHERE finalization_id=p_id AND report_digest=d; END IF;
  PERFORM public.economic_record_incident(p_id,'SIGNER_RESULT_CONFLICT','sha256:'||d);
  RETURN stored_id;
END; $$;
REVOKE ALL ON FUNCTION economic_record_signer_conflict(uuid,jsonb,bytea) FROM PUBLIC;
CREATE VIEW economic_signer_report_summary AS SELECT report_id,finalization_id,report,report_digest,database_actor,occurred_at FROM economic_signer_reports;

-- Preserve accepted and rejected observer evidence without letting malformed/late reports mutate accounting.
CREATE TABLE economic_observer_reports (
  report_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), finalization_id uuid NOT NULL REFERENCES economic_finalizations,
  source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 192),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 192),
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND octet_length(report::text)<=32768),
  report_digest text NOT NULL CHECK(report_digest~'^[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK(disposition IN ('PENDING','POSSIBLE_EFFECT','FINALIZED','INCIDENT')),
  effect_evidence_id uuid REFERENCES economic_effect_evidence,
  database_actor text NOT NULL DEFAULT session_user, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(finalization_id,source_id,reference,report_digest)
);
CREATE TRIGGER economic_observer_reports_immutable BEFORE UPDATE OR DELETE ON economic_observer_reports
  FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();
CREATE FUNCTION economic_ingest_observation(p_id uuid,p_expected_source text,p_report jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f public.economic_finalizations%ROWTYPE; d text; source text; ref text; kind text; problem text;
  report_disposition text; created_report_id uuid; effect_id uuid; b numeric; pr numeric; rent numeric; prior public.economic_observer_reports%ROWTYPE;
BEGIN
  f:=public.economic_lock_operation(p_id);
  IF jsonb_typeof(p_report)<>'object' OR octet_length(p_report::text)>32768 THEN RAISE EXCEPTION 'bounded observer report object required'; END IF;
  d:=encode(public.digest(p_report::text,'sha256'),'hex');
  source:=COALESCE(NULLIF(left(p_report->>'sourceId',192),''),'unidentified');
  ref:=COALESCE(NULLIF(left(p_report->>'reference',192),''),'sha256:'||d);
  SELECT * INTO prior FROM public.economic_observer_reports WHERE finalization_id=p_id AND source_id=source AND reference=ref AND report_digest=d;
  IF FOUND THEN RETURN prior.report_id; END IF;
  kind:=p_report->>'state';
  IF p_expected_source IS NULL OR p_report->>'sourceId' IS DISTINCT FROM p_expected_source THEN problem:='OBSERVER_SOURCE_MISMATCH';
  ELSIF p_report->'network' IS DISTINCT FROM f.tuple->'network' THEN problem:='OBSERVER_NETWORK_MISMATCH';
  ELSIF p_report->>'finalizationId' IS DISTINCT FROM p_id::text THEN problem:='OBSERVER_OPERATION_MISMATCH';
  ELSIF EXISTS(SELECT 1 FROM public.economic_observer_reports WHERE finalization_id=p_id AND source_id=source AND reference=ref AND report_digest<>d) THEN problem:='OBSERVER_REFERENCE_CONFLICT';
  ELSIF kind IS NULL OR kind NOT IN ('UNKNOWN','POSSIBLE_EFFECT','FINALIZED') THEN problem:='MALFORMED_OBSERVER_REPORT';
  ELSIF kind<>'UNKNOWN' AND f.signer_state IN ('EXPIRED_NEVER_CONTACTED','REFUSED') THEN problem:='OBSERVER_AFTER_TERMINAL';
  ELSIF kind<>'UNKNOWN' AND f.signer_state='NOT_CONTACTED' THEN problem:='EFFECT_WITHOUT_CONTACT';
  ELSIF kind<>'UNKNOWN' AND (p_report->>'transactionId' IS NULL OR (f.final_transaction_id IS NOT NULL AND p_report->>'transactionId' IS DISTINCT FROM f.final_transaction_id)) THEN problem:='OBSERVER_TRANSACTION_MISMATCH';
  ELSIF kind<>'UNKNOWN' AND EXISTS(SELECT 1 FROM public.economic_effect_evidence e WHERE e.finalization_id=p_id AND e.transaction_id IS NOT NULL AND e.transaction_id IS DISTINCT FROM p_report->>'transactionId') THEN problem:='OBSERVER_TRANSACTION_CONFLICT';
  ELSIF kind='FINALIZED' THEN
    IF f.signer_state<>'RESULT_AVAILABLE' OR p_report->>'outcome' IS NULL OR p_report->>'outcome' NOT IN ('settled','failed-onchain') OR
      COALESCE(p_report->>'base','')!~'^(0|[1-9][0-9]{0,19})$' OR COALESCE(p_report->>'priority','')!~'^(0|[1-9][0-9]{0,19})$' OR COALESCE(p_report->>'rent','')!~'^(0|[1-9][0-9]{0,19})$' THEN problem:='MALFORMED_FINALIZED_REPORT';
    ELSE
      b:=(p_report->>'base')::numeric; pr:=(p_report->>'priority')::numeric; rent:=(p_report->>'rent')::numeric;
      IF b>f.base_requested OR pr>f.priority_requested OR rent>f.rent_requested THEN problem:='OBSERVER_ACCOUNTING_CONFLICT'; END IF;
      IF EXISTS(SELECT 1 FROM public.economic_observer_reports WHERE finalization_id=p_id AND disposition='FINALIZED' AND
        ROW(report->>'outcome',report->>'base',report->>'priority',report->>'rent') IS DISTINCT FROM ROW(p_report->>'outcome',p_report->>'base',p_report->>'priority',p_report->>'rent')) THEN problem:='OBSERVER_FINALITY_CONFLICT'; END IF;
      IF f.exposure_state='CONSUMED' AND ROW(f.base_consumed,f.priority_consumed,f.rent_consumed) IS DISTINCT FROM ROW(b,pr,rent) THEN problem:='OBSERVER_ACCOUNTING_CONFLICT'; END IF;
    END IF;
  END IF;
  IF problem IS NULL AND kind<>'UNKNOWN' AND EXISTS(SELECT 1 FROM public.economic_authority_incidents WHERE finalization_id=p_id) THEN problem:='OBSERVATION_WHILE_FROZEN'; END IF;
  IF problem IS NOT NULL THEN
    report_disposition:='INCIDENT'; PERFORM public.economic_record_incident(p_id,problem,'sha256:'||d);
  ELSIF kind='UNKNOWN' THEN report_disposition:='PENDING';
  ELSE
    report_disposition:=CASE WHEN kind='FINALIZED' THEN 'FINALIZED' ELSE 'POSSIBLE_EFFECT' END;
    IF kind='FINALIZED' THEN
      SELECT effect_evidence_id INTO effect_id FROM public.economic_observer_reports WHERE finalization_id=p_id AND disposition='FINALIZED' ORDER BY occurred_at,report_id LIMIT 1;
      IF effect_id IS NULL AND f.exposure_state='CONSUMED' THEN SELECT evidence_id INTO effect_id FROM public.economic_effect_evidence WHERE finalization_id=p_id AND reference=f.accounting_reference AND kind='FINALIZED_ACCOUNTING'; END IF;
    END IF;
    IF effect_id IS NULL THEN
      effect_id:=gen_random_uuid();
      INSERT INTO public.economic_effect_evidence(evidence_id,finalization_id,kind,network,transaction_id,reference,base_consumed,priority_consumed,rent_consumed)
        VALUES(effect_id,p_id,CASE WHEN kind='FINALIZED' THEN 'FINALIZED_ACCOUNTING' ELSE 'POSSIBLE_EFFECT' END,p_report->'network',p_report->>'transactionId',CASE WHEN kind='FINALIZED' AND f.exposure_state='CONSUMED' THEN f.accounting_reference ELSE 'observer:'||d END,b,pr,rent);
    END IF;
  END IF;
  INSERT INTO public.economic_observer_reports(finalization_id,source_id,reference,report,report_digest,disposition,effect_evidence_id)
    VALUES(p_id,source,ref,p_report,d,report_disposition,effect_id) RETURNING economic_observer_reports.report_id INTO created_report_id;
  INSERT INTO public.economic_authority_events(event_type,actor,intent_id,generation,finalization_id,reference)
    VALUES('OBSERVER_REPORT_RECORDED',source,f.intent_id,f.generation,p_id,created_report_id::text);
  RETURN created_report_id;
END; $$;
REVOKE ALL ON FUNCTION economic_record_incident(uuid,text,text),economic_ingest_observation(uuid,text,jsonb) FROM PUBLIC;

CREATE VIEW economic_authority_trace AS SELECT f.finalization_id,f.intent_id,f.generation,f.consent_id,f.runtime_id,c.account_session_id,
  c.principal_id,c.authenticated_at,c.confirmed_at,f.signer_operation_id,f.signer_state,f.tuple_digest,f.artifact_reference,f.final_transaction_id,
  f.exposure_id,f.exposure_state,f.budget_id,f.budget_version,f.base_requested,f.priority_requested,f.rent_requested,
  f.base_consumed,f.priority_consumed,f.rent_consumed,f.accounting_reference,
  EXISTS(SELECT 1 FROM economic_signer_contact_authority a WHERE a.finalization_id=f.finalization_id) AS contact_committed,
  EXISTS(SELECT 1 FROM economic_authority_incidents i WHERE i.finalization_id=f.finalization_id) AS manual_review_required,
  s.created_at AS session_created_at,s.expires_at AS session_expires_at,s.revoked_at AS session_revoked_at,
  ac.account_id,ac.version AS account_version,ac.status AS account_status,
  (SELECT jsonb_agg(jsonb_build_object('type',e.event_type,'accountVersion',e.account_version,'occurredAt',e.occurred_at) ORDER BY e.event_id)
    FROM account_security_events e WHERE e.session_id=c.account_session_id) AS session_security_events
  FROM economic_finalizations f JOIN economic_consent_evidence c USING(consent_id)
  LEFT JOIN account_sessions s ON s.session_id=c.account_session_id LEFT JOIN accounts ac ON ac.actor_subject=c.principal_id;
