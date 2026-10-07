#!/usr/bin/env bash
# Builds one service from a git ref (in a git worktree) and restarts its container on that build.
# Usage: deploy.sh <service> <git-ref>
#   service: ledger-service | settlement-service | reconciliation-batch
source "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || { sed -n '2,4p' "$0"; exit 2; }
SERVICE="$1"; REF="$2"
is_app_service "$SERVICE" || die "Unknown service: $SERVICE"
[ -n "$(compose ps --status running -q postgres 2>/dev/null)" ] || die "The stack isn't running (run demo/scripts/up.sh)"

caption "${ACTION:-Deploying} $SERVICE → $REF  ${DIM}(was: $(deployed_ref "$SERVICE"))"
deploy_service "$SERVICE" "$REF"
