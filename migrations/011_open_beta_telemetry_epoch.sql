CREATE TABLE telemetry_epochs (
  epoch_name text PRIMARY KEY,
  starts_at timestamptz NOT NULL,
  established_at timestamptz NOT NULL,
  provenance_note text NOT NULL,
  CONSTRAINT telemetry_epochs_name_canonical CHECK (epoch_name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT telemetry_epochs_provenance_present CHECK (length(btrim(provenance_note)) BETWEEN 1 AND 1000),
  CONSTRAINT telemetry_epochs_established_after_start CHECK (established_at >= starts_at)
);

INSERT INTO telemetry_epochs(epoch_name, starts_at, established_at, provenance_note)
VALUES (
  'OPEN_BETA',
  TIMESTAMPTZ '2026-08-09T06:09:34.531759Z',
  TIMESTAMPTZ '2026-08-09T06:09:34.531759Z',
  'ZephiPay Open Beta operational epoch deliberately established after production payment-flow validation and immediately before external beta testing was authorized.'
);

CREATE TRIGGER telemetry_epochs_append_only
  BEFORE UPDATE OR DELETE ON telemetry_epochs
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
