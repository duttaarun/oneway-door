-- Expand: add the new column next to the old one.
-- Nullable, so the current release (which doesn't know about it) keeps inserting rows.
ALTER TABLE ledger_entries ADD COLUMN amount_minor bigint;
