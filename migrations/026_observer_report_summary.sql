-- AUD-TAC-02: preserve forensic JSON; expose only typed, bounded support fields.
-- No economic transition, evidence-validation or accounting behavior changes.
CREATE VIEW public.economic_observer_report_summary WITH (security_barrier=true) AS
SELECT report_id,finalization_id,report_digest,disposition,effect_evidence_id,database_actor,occurred_at,
  CASE WHEN jsonb_typeof(report->'sourceId')='string' AND length(report->>'sourceId')<=192 THEN source_id END AS source_id,
  CASE WHEN jsonb_typeof(report->'reference')='string' AND length(report->>'reference')<=192 THEN reference END AS reference,
  CASE WHEN report->>'state' IN ('UNKNOWN','POSSIBLE_EFFECT','FINALIZED') THEN report->>'state' END AS observation_state,
  CASE WHEN jsonb_typeof(report->'transactionId')='string' AND length(report->>'transactionId')<=192 THEN report->>'transactionId' END AS transaction_id,
  CASE WHEN report->>'outcome' IN ('settled','failed-onchain') THEN report->>'outcome' END AS outcome,
  CASE WHEN jsonb_typeof(report->'network'->'family')='string' AND length(report->'network'->>'family')<=32 THEN report->'network'->>'family' END AS network_family,
  CASE WHEN jsonb_typeof(report->'network'->'environment')='string' AND length(report->'network'->>'environment')<=32 THEN report->'network'->>'environment' END AS network_environment,
  CASE WHEN jsonb_typeof(report->'network'->'genesisHash')='string' AND length(report->'network'->>'genesisHash')<=64 THEN report->'network'->>'genesisHash' END AS network_genesis_hash,
  CASE WHEN report->>'base' ~ '^(0|[1-9][0-9]{0,19})$' THEN report->>'base' END AS base_consumed,
  CASE WHEN report->>'priority' ~ '^(0|[1-9][0-9]{0,19})$' THEN report->>'priority' END AS priority_consumed,
  CASE WHEN report->>'rent' ~ '^(0|[1-9][0-9]{0,19})$' THEN report->>'rent' END AS rent_consumed
FROM public.economic_observer_reports;

-- Revoke old group access atomically on upgrades, including any column ACLs.
-- Fresh installations may not have group roles yet; the explicit role installer grants summary access.
DO $$ DECLARE recipient text; column_name text; BEGIN
  FOREACH recipient IN ARRAY ARRAY['PUBLIC','zephipay_economic_app','zephipay_economic_reader'] LOOP
    IF recipient='PUBLIC' OR to_regrole(recipient) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.economic_observer_reports FROM %s',CASE WHEN recipient='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(recipient) END);
      FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='public.economic_observer_reports'::regclass AND attnum>0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON public.economic_observer_reports FROM %s',column_name,CASE WHEN recipient='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(recipient) END);
      END LOOP;
    END IF;
  END LOOP;
END; $$;
