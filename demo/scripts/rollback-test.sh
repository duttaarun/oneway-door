#!/usr/bin/env bash
# Proves whether <to-ref> can be rolled back to <from-ref>, for real.
#
#   1. Clean start at <from-ref>, send traffic.
#   2. Deploy ledger-service (and reconciliation-batch) at <to-ref>, send traffic.  new consumer, old producer
#   3. Deploy settlement-service at <to-ref>, send traffic.                         both new
#   4. Roll ledger-service back to <from-ref>, send traffic.                        old consumer, new producer
#   5. Roll settlement-service back to <from-ref>, send traffic.                    both old
#
# After every stage it asserts: both services healthy, every settlement booked once, no £0.00 rows,
# an empty dead-letter topic, no backlog, and a reconciliation total equal to what was sent.
#
# Usage: rollback-test.sh <from-ref> <to-ref>      (TRAFFIC=20 per stage by default)
# Exit code: 0 = PASS, 1 = FAIL.
source "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || { sed -n '2,14p' "$0"; exit 2; }
FROM="$1"; TO="$2"; TRAFFIC="${TRAFFIC:-20}"
DIR="$(cd "$(dirname "$0")" && pwd)"
resolve_commit "$FROM" >/dev/null; resolve_commit "$TO" >/dev/null
LOG="$STATE/logs/rollback-test-$(echo "$FROM-$TO" | tr '/' '_').log"; : > "$LOG"

REASONS="$STATE/rollback-reasons.$$"; : > "$REASONS"
trap 'rm -f "$REASONS"' EXIT
reason() { echo "$*" >> "$REASONS"; }

ledger_at="$FROM"; settlement_at="$FROM"

move() { # service ref stage
  if ! deploy_service "$1" "$2" >>"$LOG" 2>&1; then
    reason "$3: $1 @ $2 did not start: $(startup_failure "$1")"
  fi
  if [ "$1" = ledger-service ]; then
    deploy_service reconciliation-batch "$2" >>"$LOG" 2>&1 || reason "$3: reconciliation-batch @ $2 did not build"
  fi
}

row() { printf '  %-30s %-20s %-20s %-7s %-6s %-4s %-4s %s\n' "$@"; }

stage() { # name
  local name="$1" ok=1 lh sh rows zero dlt lag recon total mism expected_rows expected_total recon_cell
  "$DIR/traffic.sh" "$TRAFFIC" >>"$LOG" 2>&1 || reason "$name: settlement-service did not accept all traffic"
  if [ "$(health_status ledger-service)" = UP ]; then wait_for_drain 60 || true; else sleep 3; fi

  lh="$(health_status ledger-service)"; sh="$(health_status settlement-service)"
  rows="$(psql_q "SELECT count(*) FROM ledger_entries" 2>/dev/null || echo '?')"
  zero="$(psql_q "SELECT count(*) FROM ledger_entries WHERE $(zero_condition)" 2>/dev/null || echo '?')"
  dlt="$(dlt_count)"; lag="$(consumer_lag)"
  recon="$(run_reconciliation | grep '^RECON' | tail -1 || true)"
  expected_rows="$(sent_count)"; expected_total="$(sent_total)"
  total="$(printf '%s' "$recon" | sed -n 's/.*total=\([0-9.]*\).*/\1/p')"
  mism="$(printf '%s' "$recon" | sed -n 's/.*mismatches=\([0-9]*\).*/\1/p')"

  [ "$lh" = UP ] || { ok=0; reason "$name: ledger-service is $lh"; }
  [ "$sh" = UP ] || { ok=0; reason "$name: settlement-service is $sh"; }
  [ "$zero" = 0 ] || { ok=0; reason "$name: $zero rows booked at £0.00"; }
  [ "$dlt" = 0 ] || { ok=0; reason "$name: $dlt records in the dead-letter topic"; }
  [ "$lag" = 0 ] || { ok=0; reason "$name: $lag settlements not booked (backlog)"; }
  [ "$rows" = "$expected_rows" ] || { ok=0; reason "$name: $rows rows booked, $expected_rows sent"; }
  if [ -z "$total" ]; then
    ok=0; reason "$name: reconciliation failed: $(printf '%s' "$recon" | sed -n 's/^RECON error=//p')"
    recon_cell="${RED}error${RESET}"
  elif [ "$total" != "$expected_total" ]; then
    ok=0; reason "$name: reconciliation £$total, sent £$expected_total"
    recon_cell="${RED}£$total ≠ £$expected_total${RESET}"
  else
    recon_cell="£$total"
  fi
  if [ -n "$mism" ] && [ "$mism" != 0 ]; then ok=0; reason "$name: amount and amount_minor disagree on $mism rows"; fi

  local verdict="${GREEN}ok${RESET}"; [ "$ok" = 1 ] || verdict="${RED}FAIL${RESET}"
  row "$name" "$(short "$ledger_at")" "$(short "$settlement_at")" "$rows/$expected_rows" "$zero" "$dlt" "$lag" "$recon_cell  $verdict"
}

short() { printf '%s' "$1" | cut -c1-20; }

caption "Rollback test: $FROM → $TO → back to $FROM  ${DIM}($TRAFFIC settlements per stage)"
info "  clean start at $FROM…"
"$DIR/down.sh" >>"$LOG" 2>&1
if ! "$DIR/up.sh" "$FROM" >>"$LOG" 2>&1; then
  fail "baseline at $FROM did not start (see $LOG)"; exit 1
fi

echo
row "Stage" "ledger-service" "settlement-service" "Rows" "£0.00" "DLT" "Lag" "Reconciliation"
stage "1 baseline"

move ledger-service "$TO" "2 deploy ledger"; ledger_at="$TO"
stage "2 deploy ledger"

move settlement-service "$TO" "3 deploy settlement"; settlement_at="$TO"
stage "3 deploy settlement"

move ledger-service "$FROM" "4 roll back ledger"; ledger_at="$FROM"
stage "4 roll back ledger"

move settlement-service "$FROM" "5 roll back settlement"; settlement_at="$FROM"
stage "5 roll back settlement"

echo
if [ -s "$REASONS" ]; then
  printf '%s\n' "${RED}${BOLD}FAIL${RESET}  $FROM → $TO cannot be rolled back safely:"
  awk '!seen[$0]++' "$REASONS" | head -12 | sed 's/^/    - /'
  printf '%s\t%s\tFAIL\t%s\n' "$FROM" "$TO" "$(head -1 "$REASONS")" >> "$STATE/rollback-results.tsv"
  exit 1
fi
printf '%s\n' "${GREEN}${BOLD}PASS${RESET}  $FROM → $TO deploys and rolls back with no errors, no £0.00 rows, an empty DLT and correct totals."
printf '%s\t%s\tPASS\t\n' "$FROM" "$TO" >> "$STATE/rollback-results.tsv"
