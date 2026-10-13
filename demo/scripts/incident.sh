#!/usr/bin/env bash
# "The £0.00 Settlement", reproduced for real: real builds from git, a real rollback,
# a real hand-written hotfix, and real events that v1 books at £0.00 without a single error.
#
# Usage: incident.sh [--no-pause]        (or PAUSE=0 incident.sh)
# Exit code 0 means the incident reproduced exactly as described.
source "$(dirname "$0")/lib.sh"

BAD="pr-482-minor-units"
DIR="$(cd "$(dirname "$0")" && pwd)"
[ "${1:-}" = "--no-pause" ] && PAUSE=0
git -C "$ROOT" rev-parse --verify --quiet "$BAD^{commit}" >/dev/null || die "branch $BAD not found"

say() { printf '%s\n' "  $*"; }

caption "0 · Friday 16:30. Northwind Payments runs v1 (main). Settlements are booked in pounds."
"$DIR/down.sh" >/dev/null
"$DIR/up.sh" main
"$DIR/traffic.sh" 10
wait_for_drain 60 || warn "ledger-service is still catching up"
"$DIR/ledger.sh" 5
pause "merge PR #482"

caption "1 · 16:40. PR #482 'store amounts in minor units' is merged. Tests are green. Ship it."
say "ledger-service goes first: Flyway runs V3 (rename amount → amount_minor, retype to pence)."
"$DIR/deploy.sh" ledger-service "$BAD"
"$DIR/deploy.sh" settlement-service "$BAD"
"$DIR/traffic.sh" 20
wait_for_drain 60 || warn "ledger-service is still catching up"
"$DIR/ledger.sh" 5
pause "16:55"

caption "2 · 16:55. Finance's reconciliation job starts failing."
say "Nobody changed reconciliation-batch. It still reads ledger_entries.amount directly."
recon="$(run_reconciliation)"
printf '%s\n' "$recon" | { grep -v '^RECON' || true; } | sed 's/^/    /'
printf '    %s\n' "${RED}reconciliation-batch: $(printf '%s\n' "$recon" | sed -n 's/^RECON error=//p')${RESET}"
say "On-call sees ledger_entries in the stack trace and rolls back the service that owns it."
pause "roll back ledger-service"

caption "3 · 16:58. Roll back ledger-service to v1. The rollback button works; the service doesn't."
"$DIR/rollback.sh" ledger-service main && die "expected v1 to fail against the V3 schema"
say "v1 expects a column called amount. V3 renamed it. Flyway can't undo it: there is no undo."
pause "carry on trading"

caption "4 · 17:00–17:25. Settlements keep coming. settlement-service is still v2."
"$DIR/traffic.sh" 50
backlog_total="$(tail -50 "$SENT_FILE" | awk '{s+=$1} END {printf "%.2f", s}')"
say "These 50 events (£$backlog_total) carry amountMinor and no amount. ledger-service is down, so they queue."
say "Backlog on payments.settled: ${BOLD}$(consumer_lag)${RESET} events"
pause "apply the hotfix"

caption "5 · 17:25. A DBA reverses V3 by hand so v1 can start again."
"$DIR/apply-hotfix.sh"
say "v1 drains the backlog…"
wait_for_drain 90 || warn "backlog not fully drained"
pause "check the ledger"

caption "6 · 17:26. Incident closed. Every dashboard is green."
"$DIR/ledger.sh" 8
recon="$(run_reconciliation)"
booked="$(printf '%s\n' "$recon" | sed -n 's/^RECON .*total=\([0-9.]*\).*/\1/p')"
expected="$(sent_total)"
missing="$(awk -v e="$expected" -v b="${booked:-0}" 'BEGIN {printf "%.2f", e - b}')"
zero="$(psql_q "SELECT count(*) FROM ledger_entries WHERE $(zero_condition)")"
dlt="$(dlt_count)"; health="$(health_status ledger-service)"

caption "What happened"
say "Reconciliation total: £$booked. Settlements sent: £$expected. ${RED}${BOLD}£$missing is missing.${RESET}"
say "$zero settlements were booked at £0.00. No exception. Nothing in the dead-letter topic ($dlt records)."
say "Why: v1 reads the v2 events by field name. Jackson ignores the unknown amountMinor,"
say "and the missing primitive 'double amount' quietly stays 0.0."
say "Rolling back the code didn't roll back the database or the events already on the topic."
say "PR #482 was a one-way door."

if [ "$zero" = 50 ] && [ "$dlt" = 0 ] && [ "$health" = UP ] && [ "$missing" = "$backlog_total" ]; then
  printf '\n%s\n' "${GREEN}${BOLD}Reproduced: 50 rows at £0.00, empty DLT, ledger-service healthy.${RESET}"
else
  printf '\n%s\n' "${RED}${BOLD}Did not reproduce cleanly: zero=$zero dlt=$dlt health=$health missing=£$missing (expected £$backlog_total).${RESET}"
  exit 1
fi
