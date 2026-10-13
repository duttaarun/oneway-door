#!/usr/bin/env bash
# Applies hotfix-reverse-v3.sql to the ledger database and restarts ledger-service.
source "$(dirname "$0")/lib.sh"

caption "Applying hotfix-reverse-v3.sql"
has_column amount_minor || die "ledger_entries has no amount_minor column; V3 isn't applied, nothing to reverse"
compose exec -T postgres psql -U northwind -d ledger -X -q -v ON_ERROR_STOP=1 \
  < "$(dirname "$0")/hotfix-reverse-v3.sql" || die "hotfix failed"
ok "ledger_entries.amount_minor (pence, bigint) is back to amount (pounds, numeric(12,2))"
compose up -d --no-deps --force-recreate ledger-service >/dev/null 2>&1
wait_healthy ledger-service 120 "$(deployed_ref ledger-service)"
