CREATE INDEX ledger_entries_merchant_settled_idx ON ledger_entries (merchant_id, settled_at);
