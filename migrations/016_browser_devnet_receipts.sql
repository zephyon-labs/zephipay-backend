ALTER TABLE payment_execution_receipts DROP CONSTRAINT payment_execution_receipts_rail_check;
ALTER TABLE payment_execution_receipts ADD CONSTRAINT payment_execution_receipts_rail_check CHECK (rail IN ('mock','solana'));
