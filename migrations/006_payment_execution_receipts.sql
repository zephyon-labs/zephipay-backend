ALTER TABLE payment_executions
  ADD CONSTRAINT payment_executions_ownership_unique UNIQUE (execution_id, payment_intent_id, actor_subject);

CREATE TABLE payment_execution_receipts (
  receipt_id text PRIMARY KEY CHECK (receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  execution_id uuid NOT NULL UNIQUE,
  payment_intent_id uuid NOT NULL UNIQUE,
  actor_subject text NOT NULL,
  runtime_transaction_id text NOT NULL,
  rail text NOT NULL CHECK (rail = 'mock'),
  asset text NOT NULL CHECK (asset = 'USDC'),
  amount_units numeric(78,0) NOT NULL CHECK (amount_units > 0),
  amount_decimals integer NOT NULL CHECK (amount_decimals BETWEEN 0 AND 18),
  sender_id text NOT NULL,
  recipient_id text NOT NULL,
  recipient_snapshot jsonb,
  memo text NOT NULL,
  provider_reference text,
  settled_at timestamptz NOT NULL,
  evidence_type text NOT NULL,
  evidence_version integer NOT NULL CHECK (evidence_version > 0),
  evidence jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  created_at timestamptz NOT NULL,
  CONSTRAINT payment_execution_receipts_execution_owner_fk
    FOREIGN KEY (execution_id, payment_intent_id, actor_subject)
    REFERENCES payment_executions(execution_id, payment_intent_id, actor_subject) ON DELETE RESTRICT
);

CREATE INDEX payment_execution_receipts_actor_time_idx
  ON payment_execution_receipts(actor_subject, settled_at DESC, receipt_id);

-- Batch 1 may already have conclusively settled Mock executions. Backfill those
-- from their durable execution/payment truth so the upgrade never commits a
-- settled execution without its one canonical receipt.
INSERT INTO payment_execution_receipts(
  receipt_id,execution_id,payment_intent_id,actor_subject,runtime_transaction_id,
  rail,asset,amount_units,amount_decimals,sender_id,recipient_id,recipient_snapshot,
  memo,provider_reference,settled_at,evidence_type,evidence_version,evidence,
  schema_version,request_hash,created_at
)
SELECT
  'receipt:' || e.execution_id::text,e.execution_id,e.payment_intent_id,e.actor_subject,e.execution_id::text,
  'mock',p.asset,p.amount_raw,6,
  'actor:' || substr(encode(digest(e.actor_subject,'sha256'),'hex'),1,32),
  COALESCE(p.recipient_account_id::text,'recipient:' || substr(encode(digest(p.recipient_address,'sha256'),'hex'),1,32)),
  p.recipient_snapshot,p.purpose,e.provider_reference,e.settled_at,
  'mock.execution',1,e.settlement_evidence,1,p.request_hash,e.settled_at
FROM payment_executions e
JOIN payments p ON p.id=e.payment_intent_id AND p.actor_subject=e.actor_subject
WHERE e.status='SETTLED';

INSERT INTO payment_execution_events(execution_id,sequence_number,event_type,from_status,to_status,occurred_at)
SELECT e.execution_id,COALESCE((SELECT MAX(sequence_number) FROM payment_execution_events prior WHERE prior.execution_id=e.execution_id),0)+1,
       'execution_settled','PROCESSING','SETTLED',e.settled_at
FROM payment_executions e
WHERE e.status='SETTLED' AND NOT EXISTS (
  SELECT 1 FROM payment_execution_events prior WHERE prior.execution_id=e.execution_id AND prior.event_type='execution_settled'
);

INSERT INTO payment_execution_events(execution_id,sequence_number,event_type,from_status,to_status,occurred_at)
SELECT r.execution_id,COALESCE((SELECT MAX(sequence_number) FROM payment_execution_events prior WHERE prior.execution_id=r.execution_id),0)+1,
       'receipt_created','SETTLED','SETTLED',r.created_at
FROM payment_execution_receipts r
WHERE NOT EXISTS (
  SELECT 1 FROM payment_execution_events prior WHERE prior.execution_id=r.execution_id AND prior.event_type='receipt_created'
);

CREATE TRIGGER payment_execution_receipts_append_only
  BEFORE UPDATE OR DELETE ON payment_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE UNIQUE INDEX payment_execution_events_terminal_fact_once
  ON payment_execution_events(execution_id, event_type)
  WHERE event_type IN ('execution_created', 'execution_settled', 'receipt_created');
