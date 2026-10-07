#!/usr/bin/env bash
# Fires N settlements at settlement-service as fast as it will take them.
# Their settledAt times are spaced 30s apart and end now, so 50 events replay
# "the last 25 minutes of settlements" in a couple of seconds.
# Usage: traffic.sh [count]   (default 50)
source "$(dirname "$0")/lib.sh"

COUNT="${1:-50}"
SPACING="${SPACING:-30}"
URL="http://localhost:8081/settlements"
case "$COUNT" in ''|*[!0-9]*) die "count must be a number" ;; esac
[ "$(health_status settlement-service)" = UP ] || die "settlement-service is not up (run demo/scripts/up.sh)"

if date -u -r 0 +%s >/dev/null 2>&1; then iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
else iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }; fi

batch="$STATE/traffic.$$"; ok_file="$batch.ok"; : > "$ok_file"
now="$(date -u +%s)"; start=$((now - COUNT * SPACING))
i=1
while [ "$i" -le "$COUNT" ]; do
  pence=$(( (RANDOM * 32768 + RANDOM) % 49900 + 100 ))          # £1.00 to £499.99
  printf 'merchant-%04d %d.%02d %s\n' $((RANDOM % 40 + 1)) $((pence / 100)) $((pence % 100)) \
    "$(iso $((start + i * SPACING)))"
  i=$((i + 1))
done > "$batch"

t0=$(date +%s)
export URL OK_FILE="$ok_file"
# shellcheck disable=SC2016
xargs -P 8 -n 3 sh -c '
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
    -d "{\"merchantId\":\"$1\",\"currency\":\"GBP\",\"amount\":$2,\"settledAt\":\"$3\"}" "$URL")
  if [ "$code" = 202 ]; then echo "$2" >> "$OK_FILE"; else echo "  settlement failed: HTTP $code" >&2; fi
' _ < "$batch" || true
t1=$(date +%s)

sent=$(awk 'END {print NR+0}' "$ok_file")
total=$(awk '{s+=$1} END {printf "%.2f", s+0}' "$ok_file")
cat "$ok_file" >> "$SENT_FILE"
first=$(awk 'NR==1 {print substr($3, 12, 5)}' "$batch"); last=$(awk 'END {print substr($3, 12, 5)}' "$batch")
rm -f "$batch" "$ok_file"

if [ "$sent" = "$COUNT" ]; then
  ok "sent $sent settlements worth £$total (settledAt $first–$last UTC) in $((t1 - t0))s"
else
  fail "only $sent of $COUNT settlements were accepted (£$total)"
  exit 1
fi
