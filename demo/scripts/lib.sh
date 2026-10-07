# Shared helpers for the demo scripts. Source it; don't run it.
# Works with the bash 3.2 that ships with macOS.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO="$ROOT/demo"
STATE="$ROOT/.demo"
mkdir -p "$STATE/logs" "$STATE/deployed"

compose() { docker compose -f "$DEMO/docker-compose.yml" "$@"; }

# ---------- output ----------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=; DIM=; RED=; GREEN=; YELLOW=; CYAN=; RESET=
fi
info() { printf '%s\n' "${DIM}$*${RESET}"; }
ok()   { printf '%s\n' "${GREEN}✔ $*${RESET}"; }
warn() { printf '%s\n' "${YELLOW}! $*${RESET}"; }
fail() { printf '%s\n' "${RED}✘ $*${RESET}"; }
die()  { fail "$*"; exit 1; }

# ---------- services ----------
APP_SERVICES="ledger-service settlement-service reconciliation-batch"

is_app_service() {
  case "$1" in ledger-service|settlement-service|reconciliation-batch) return 0 ;; *) return 1 ;; esac
}

service_port() {
  case "$1" in settlement-service) echo 8081 ;; ledger-service) echo 8082 ;; *) echo "" ;; esac
}

# ---------- git refs -> images ----------
# Image tags follow the service folder's git tree hash, so a ref is only built once
# and two refs with identical service code share an image.
resolve_commit() { git -C "$ROOT" rev-parse --verify --quiet "$1^{commit}" || die "Unknown git ref: $1"; }

image_for() { # service ref
  local tree
  tree="$(git -C "$ROOT" rev-parse --verify --quiet "$(resolve_commit "$2"):demo/$1")" \
    || die "demo/$1 does not exist at $2"
  echo "owd/$1:${tree:0:12}"
}

build_image() { # service ref -> prints image
  local service="$1" ref="$2" image commit wt log
  image="$(image_for "$service" "$ref")"
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "$image"; return 0
  fi
  commit="$(resolve_commit "$ref")"
  wt="$STATE/worktrees/$service-${commit:0:12}"
  log="$STATE/logs/build-$service-${commit:0:12}.log"
  rm -rf "$wt"; git -C "$ROOT" worktree prune
  git -C "$ROOT" worktree add --quiet --detach "$wt" "$commit"
  info "  building $service from $ref (${commit:0:7}) in a git worktree…" >&2
  if ! docker build -t "$image" "$wt/demo/$service" >"$log" 2>&1; then
    tail -30 "$log" >&2
    git -C "$ROOT" worktree remove --force "$wt" || true
    die "Build failed for $service at $ref (full log: $log)"
  fi
  git -C "$ROOT" worktree remove --force "$wt"
  echo "$image"
}

# deploy_service service ref [timeoutSec]
# Builds the service at that ref, points the :live tag at it and restarts its container.
# Returns non-zero if the service doesn't come up healthy.
deploy_service() {
  local service="$1" ref="$2" timeout="${3:-120}" image commit
  is_app_service "$service" || die "Unknown service: $service (expected one of: $APP_SERVICES)"
  image="$(build_image "$service" "$ref")" || return 1
  commit="$(resolve_commit "$ref")" || return 1
  docker tag "$image" "owd/$service:live" || return 1
  echo "$ref (${commit:0:7})" > "$STATE/deployed/$service"
  if [ "$service" = reconciliation-batch ]; then
    ok "reconciliation-batch @ $ref (${commit:0:7}) ready (runs on demand)"
    return 0
  fi
  compose up -d --no-deps --force-recreate "$service" >/dev/null 2>&1 || return 1
  wait_healthy "$service" "$timeout" "$ref (${commit:0:7})"
}

deployed_ref() { cat "$STATE/deployed/$1" 2>/dev/null || echo "not deployed"; }

health_status() { # service -> UP / DOWN / unreachable
  local body
  body="$(curl -s --max-time 2 "http://localhost:$(service_port "$1")/actuator/health" 2>/dev/null || true)"
  case "$body" in
    *'"status":"UP"'*) echo UP ;;
    "") echo unreachable ;;
    *) echo DOWN ;;
  esac
}

container_id() { compose ps -q "$1" 2>/dev/null | head -1; }

restart_count() {
  local id n=0; id="$(container_id "$1")"
  [ -n "$id" ] && n="$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)"
  echo "${n:-0}"
}

# Prints the root cause of a failed Spring Boot start-up.
startup_failure() {
  compose logs --no-color --no-log-prefix "$1" 2>/dev/null \
    | grep -E 'Caused by: |Schema-validation|FlywayValidateException|PSQLException' \
    | tail -1 | sed -E 's/^[[:space:]]*Caused by: //' | cut -c1-220
}

wait_healthy() { # service timeoutSec label
  local service="$1" timeout="$2" label="${3:-}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if [ "$(health_status "$service")" = UP ]; then
      ok "$service @ $label is UP (http://localhost:$(service_port "$service")/actuator/health)"
      return 0
    fi
    if [ "$(restart_count "$service")" -gt 0 ] \
       || [ "$(compose logs --no-color "$service" 2>/dev/null | grep -c 'APPLICATION FAILED TO START')" -gt 0 ]; then
      fail "$service @ $label failed to start and is restarting"
      printf '    %s\n' "${RED}$(startup_failure "$service")${RESET}"
      return 1
    fi
    sleep 1; waited=$((waited + 1))
  done
  fail "$service @ $label not healthy after ${timeout}s"
  return 1
}

# ---------- infra ----------
start_infra() {
  compose up -d --wait postgres kafka >/dev/null 2>&1 || die "postgres/kafka did not start (try: docker compose -f demo/docker-compose.yml logs)"
  compose up kafka-init >/dev/null 2>&1 || die "Could not create Kafka topics"
}

# ---------- queries ----------
psql_q() { compose exec -T postgres psql -U northwind -d ledger -AtX -v ON_ERROR_STOP=1 -c "$1"; }
psql_table() { compose exec -T postgres psql -U northwind -d ledger -X -P footer=off -c "$1"; }

has_column() { # column
  [ "$(psql_q "SELECT count(*) FROM information_schema.columns WHERE table_name='ledger_entries' AND column_name='$1'" 2>/dev/null || echo 0)" = 1 ]
}

# SQL expression for an entry's amount in pounds, whatever the current schema looks like.
amount_expr() {
  if has_column amount && has_column amount_minor; then echo "COALESCE(amount, amount_minor / 100.0)"
  elif has_column amount; then echo "amount"
  elif has_column amount_minor; then echo "amount_minor / 100.0"
  else echo "NULL::numeric"; fi
}

zero_condition() {
  local c=""
  has_column amount && c="amount = 0"
  if has_column amount_minor; then [ -n "$c" ] && c="$c OR "; c="${c}amount_minor = 0"; fi
  echo "${c:-false}"
}

dlt_count() {
  { compose exec -T kafka /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server kafka:9092 \
    --topic payments.settled.DLT 2>/dev/null || true; } | awk -F: '{s+=$3} END {print s+0}'
}

consumer_lag() {
  { compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
    --describe --group ledger-service 2>/dev/null || true; } \
    | awk '$2=="payments.settled" { if ($6 ~ /^[0-9]+$/) s+=$6; else if ($5 ~ /^[0-9]+$/) s+=$5 } END {print s+0}'
}

# Waits until ledger-service has consumed everything on the topic (or gives up).
wait_for_drain() { # timeoutSec
  local timeout="${1:-60}" waited=0 lag
  while [ "$waited" -lt "$timeout" ]; do
    lag="$(consumer_lag)"
    [ "$lag" = 0 ] && return 0
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

# Runs the deployed reconciliation-batch; prints its stdout (the RECON line included).
run_reconciliation() {
  compose --profile batch run --rm --no-deps -T reconciliation-batch 2>/dev/null || true
}

# ---------- traffic accounting ----------
SENT_FILE="$STATE/sent.amounts"

sent_count() { [ -f "$SENT_FILE" ] && awk 'END {print NR+0}' "$SENT_FILE" || echo 0; }
sent_total() { [ -f "$SENT_FILE" ] && awk '{s+=$1} END {printf "%.2f", s+0}' "$SENT_FILE" || echo 0.00; }

pause() { # message
  if [ "${PAUSE:-1}" = 1 ] && [ -t 0 ]; then
    printf '%s' "${DIM}  ↵ ${1:-continue}${RESET}"; read -r _
  fi
}

caption() {
  printf '\n%s\n' "${BOLD}${CYAN}━━ $* ${RESET}"
}
