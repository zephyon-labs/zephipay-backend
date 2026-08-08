-- Purpose is optional descriptive context. Preserve existing values while
-- allowing one canonical SQL NULL representation for future absent purposes.
ALTER TABLE payments
  ALTER COLUMN purpose DROP NOT NULL;

ALTER TABLE payments
  DROP CONSTRAINT payments_purpose_length;

ALTER TABLE payments
  ADD CONSTRAINT payments_purpose_length
    CHECK (purpose IS NULL OR octet_length(convert_to(purpose, 'UTF8')) BETWEEN 1 AND 120);

ALTER TABLE payment_execution_receipts
  ALTER COLUMN memo DROP NOT NULL;
