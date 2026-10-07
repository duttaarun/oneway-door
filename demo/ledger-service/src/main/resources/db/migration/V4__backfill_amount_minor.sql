-- Migrate: fill amount_minor for rows written before PR 1, then prove both columns agree.
-- PR 1 already writes both columns, so this only touches older rows.
-- (On a large table, run the UPDATE in batches to keep locks short.)
UPDATE ledger_entries SET amount_minor = round(amount * 100)::bigint WHERE amount_minor IS NULL;

DO $$
DECLARE
  mismatches bigint;
BEGIN
  SELECT count(*) INTO mismatches FROM ledger_entries
   WHERE amount_minor IS NULL OR amount_minor <> round(amount * 100)::bigint;
  IF mismatches > 0 THEN
    RAISE EXCEPTION 'amount and amount_minor disagree on % rows', mismatches;
  END IF;
END $$;
