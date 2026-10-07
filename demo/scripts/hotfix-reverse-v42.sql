-- HOTFIX INC-2291: reverse V42 by hand so ledger-service v1 can start again.
-- Written under pressure on a Friday afternoon. It makes the schema look like v1 again;
-- it does nothing about the v2 events already waiting on payments.settled.
BEGIN;
ALTER TABLE ledger_entries ALTER COLUMN amount_minor TYPE numeric(12,2) USING (amount_minor / 100.0);
ALTER TABLE ledger_entries RENAME COLUMN amount_minor TO amount;
-- Forget V42 so a later redeploy of v2 would run it again.
DELETE FROM flyway_schema_history WHERE version = '42';
COMMIT;
