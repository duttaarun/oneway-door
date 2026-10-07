-- Store money as integer minor units (pence) instead of decimal pounds.
-- Removes rounding risk and matches how the card schemes send amounts.
ALTER TABLE ledger_entries RENAME COLUMN amount TO amount_minor;
ALTER TABLE ledger_entries ALTER COLUMN amount_minor TYPE bigint USING (amount_minor * 100)::bigint;
