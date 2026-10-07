-- Contract: amount_minor becomes the source of truth.
-- Every row has it (V4) and the previous release writes it on every insert, so NOT NULL is safe.
ALTER TABLE ledger_entries ALTER COLUMN amount_minor SET NOT NULL;

-- From this release ledger-service no longer writes amount. The previous release and its
-- reconciliation still read it, so keep it filled from amount_minor until PR 4 drops it.
ALTER TABLE ledger_entries ALTER COLUMN amount DROP NOT NULL;

CREATE FUNCTION ledger_entries_fill_amount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount IS NULL THEN
    NEW.amount := NEW.amount_minor / 100.0;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ledger_entries_fill_amount
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_fill_amount();
