#!/usr/bin/env bash
# Shows what the ledger booked: the last 20 entries, then row counts, totals,
# consumer lag, the dead-letter topic and service health.
# Works on any schema version (amount, amount_minor or both).
source "$(dirname "$0")/lib.sh"

LIMIT="${1:-20}"
compose ps --status running -q postgres | grep -q . || die "postgres is not running (run demo/scripts/up.sh)"
if ! has_column amount && ! has_column amount_minor; then
  warn "ledger_entries has no amount column yet (ledger-service never started?)"; exit 0
fi

AMOUNT="$(amount_expr)"; ZERO="$(zero_condition)"
columns=""
has_column amount && columns="amount"
if has_column amount_minor; then columns="${columns:+$columns, }amount_minor"; fi

caption "Last $LIMIT ledger entries  ${DIM}(ledger_entries columns: $columns)"
psql_table "SELECT id, left(payment_id::text, 8) AS payment, merchant_id AS merchant,
                   '£' || to_char($AMOUNT, 'FM999999990.00') AS amount,
                   to_char(settled_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS settled_utc
            FROM ledger_entries ORDER BY id DESC LIMIT $LIMIT"

rows="$(psql_q "SELECT count(*) FROM ledger_entries")"
zero="$(psql_q "SELECT count(*) FROM ledger_entries WHERE $ZERO")"
booked="$(psql_q "SELECT to_char(COALESCE(sum($AMOUNT), 0), 'FM999999990.00') FROM ledger_entries")"
lag="$(consumer_lag)"; dlt="$(dlt_count)"

caption "Summary"
printf '  %-28s %s\n' "Rows booked" "$rows"
if [ -f "$SENT_FILE" ]; then
  printf '  %-28s %s (£%s)\n' "Settlements sent" "$(sent_count)" "$(sent_total)"
fi
printf '  %-28s £%s\n' "Total booked" "$booked"
if [ "$zero" -gt 0 ]; then
  printf '  %-29s %s\n' "Rows booked at £0.00" "${RED}${BOLD}$zero${RESET}"
else
  printf '  %-29s %s\n' "Rows booked at £0.00" "${GREEN}0${RESET}"
fi
printf '  %-28s %s\n' "Backlog (consumer lag)" "$lag"
if [ "$dlt" -gt 0 ]; then
  printf '  %-28s %s\n' "Dead-letter topic" "${RED}$dlt records${RESET}"
else
  printf '  %-28s %s\n' "Dead-letter topic" "${GREEN}empty${RESET}"
fi
for s in ledger-service settlement-service; do
  h="$(health_status "$s")"
  [ "$h" = UP ] && h="${GREEN}UP${RESET}" || h="${RED}$h${RESET}"
  printf '  %-28s %s  %s\n' "$s" "$h" "${DIM}$(deployed_ref "$s")${RESET}"
done
