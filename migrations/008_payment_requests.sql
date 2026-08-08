CREATE TYPE payment_request_status AS ENUM ('PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED','PAID');
CREATE TYPE payment_request_event_type AS ENUM ('CREATED','ACCEPTED','DECLINED','CANCELLED','EXPIRED','PAID');

CREATE TABLE payment_requests (
  request_id uuid PRIMARY KEY,
  requester_account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  requester_actor_subject text NOT NULL REFERENCES accounts(actor_subject) ON DELETE RESTRICT,
  payer_account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  requester_snapshot jsonb NOT NULL,
  payer_snapshot jsonb NOT NULL,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  asset text NOT NULL CHECK (asset='USDC'),
  purpose text CHECK (purpose IS NULL OR (purpose=btrim(purpose) AND octet_length(purpose) BETWEEN 1 AND 120)),
  status payment_request_status NOT NULL DEFAULT 'PENDING',
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  accepted_at timestamptz, declined_at timestamptz, cancelled_at timestamptz, expired_at timestamptz, paid_at timestamptz,
  linked_payment_intent_id uuid UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  linked_execution_id uuid UNIQUE REFERENCES payment_executions(execution_id) ON DELETE RESTRICT,
  linked_receipt_id text UNIQUE REFERENCES payment_execution_receipts(receipt_id) ON DELETE RESTRICT,
  CONSTRAINT payment_requests_parties_differ CHECK(requester_account_id<>payer_account_id),
  CONSTRAINT payment_requests_idempotency_unique UNIQUE(requester_actor_subject,idempotency_key),
  CONSTRAINT payment_requests_snapshot_shape CHECK(requester_snapshot->>'accountId'=lower(requester_account_id::text) AND payer_snapshot->>'accountId'=lower(payer_account_id::text) AND requester_snapshot->>'schemaVersion'='1' AND payer_snapshot->>'schemaVersion'='1'),
  CONSTRAINT payment_requests_lifecycle_shape CHECK(
    (status='PENDING' AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND paid_at IS NULL AND linked_payment_intent_id IS NULL AND linked_execution_id IS NULL AND linked_receipt_id IS NULL) OR
    (status='ACCEPTED' AND accepted_at IS NOT NULL AND declined_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND paid_at IS NULL AND linked_payment_intent_id IS NOT NULL AND linked_execution_id IS NULL AND linked_receipt_id IS NULL) OR
    (status='DECLINED' AND declined_at IS NOT NULL AND accepted_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND paid_at IS NULL AND linked_payment_intent_id IS NULL AND linked_execution_id IS NULL AND linked_receipt_id IS NULL) OR
    (status='CANCELLED' AND cancelled_at IS NOT NULL AND accepted_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND paid_at IS NULL AND linked_payment_intent_id IS NULL AND linked_execution_id IS NULL AND linked_receipt_id IS NULL) OR
    (status='EXPIRED' AND expired_at IS NOT NULL AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL AND paid_at IS NULL AND linked_payment_intent_id IS NULL AND linked_execution_id IS NULL AND linked_receipt_id IS NULL) OR
    (status='PAID' AND accepted_at IS NOT NULL AND paid_at IS NOT NULL AND linked_payment_intent_id IS NOT NULL AND linked_execution_id IS NOT NULL AND linked_receipt_id IS NOT NULL AND declined_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL)
  )
);
CREATE INDEX payment_requests_requester_time_idx ON payment_requests(requester_account_id,created_at DESC,request_id);
CREATE INDEX payment_requests_payer_time_idx ON payment_requests(payer_account_id,created_at DESC,request_id);

CREATE TABLE payment_request_events(
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES payment_requests(request_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL CHECK(sequence_number>0), event_type payment_request_event_type NOT NULL,
  from_status payment_request_status, to_status payment_request_status NOT NULL,
  occurred_at timestamptz NOT NULL, CONSTRAINT payment_request_events_sequence_unique UNIQUE(request_id,sequence_number)
);
CREATE TRIGGER payment_request_events_append_only BEFORE UPDATE OR DELETE ON payment_request_events FOR EACH ROW EXECUTE FUNCTION reject_identity_append_only_mutation();

CREATE FUNCTION protect_payment_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.requester_account_id IS DISTINCT FROM OLD.requester_account_id OR NEW.requester_actor_subject IS DISTINCT FROM OLD.requester_actor_subject OR NEW.payer_account_id IS DISTINCT FROM OLD.payer_account_id OR NEW.requester_snapshot IS DISTINCT FROM OLD.requester_snapshot OR NEW.payer_snapshot IS DISTINCT FROM OLD.payer_snapshot OR NEW.amount_raw IS DISTINCT FROM OLD.amount_raw OR NEW.asset IS DISTINCT FROM OLD.asset OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'payment request intent is immutable'; END IF;
 IF NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'invalid payment request version'; END IF;
 IF NOT ((OLD.status='PENDING' AND NEW.status IN ('ACCEPTED','DECLINED','CANCELLED','EXPIRED')) OR (OLD.status='ACCEPTED' AND NEW.status='PAID')) THEN RAISE EXCEPTION 'illegal payment request transition'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER payment_requests_protect BEFORE UPDATE ON payment_requests FOR EACH ROW EXECUTE FUNCTION protect_payment_request();

CREATE FUNCTION validate_payment_request_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM payment_request_events WHERE request_id=NEW.request_id AND sequence_number=NEW.version+1 AND to_status=NEW.status) THEN RAISE EXCEPTION 'payment request mutation requires an atomic event'; END IF;
 RETURN NEW; END $$;
CREATE CONSTRAINT TRIGGER payment_requests_event_guard AFTER INSERT OR UPDATE ON payment_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_request_event();

CREATE FUNCTION mark_payment_request_paid_from_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE payment_requests SET status='PAID',version=version+1,paid_at=NEW.settled_at,updated_at=NEW.settled_at,linked_execution_id=NEW.execution_id,linked_receipt_id=NEW.receipt_id WHERE linked_payment_intent_id=NEW.payment_intent_id AND status='ACCEPTED';
 IF FOUND THEN INSERT INTO payment_request_events(request_id,sequence_number,event_type,from_status,to_status,occurred_at) SELECT request_id,COALESCE((SELECT max(sequence_number) FROM payment_request_events e WHERE e.request_id=payment_requests.request_id),0)+1,'PAID','ACCEPTED','PAID',NEW.settled_at FROM payment_requests WHERE linked_payment_intent_id=NEW.payment_intent_id; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER payment_requests_mark_paid AFTER INSERT ON payment_execution_receipts FOR EACH ROW EXECUTE FUNCTION mark_payment_request_paid_from_receipt();
