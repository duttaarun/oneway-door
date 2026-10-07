-- Drop: nothing at this release or the previous one reads or writes amount.
-- amount_minor has held the same values since V4 checked them, so no information is lost.
DROP TRIGGER ledger_entries_fill_amount ON ledger_entries;
DROP FUNCTION ledger_entries_fill_amount();
ALTER TABLE ledger_entries DROP COLUMN amount;
