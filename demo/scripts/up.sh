#!/usr/bin/env bash
# Starts the whole demo: Postgres, Kafka, topics, and all three apps built from a git ref.
# Usage: up.sh [--ui] [git-ref]     (default ref: main)
source "$(dirname "$0")/lib.sh"

UI=0; REF=main
for arg in "$@"; do
  case "$arg" in
    --ui) UI=1 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) REF="$arg" ;;
  esac
done

caption "Starting Northwind Payments at $REF"
start_infra
ok "postgres and kafka are up; topics payments.settled and payments.settled.DLT exist"
for service in ledger-service settlement-service reconciliation-batch; do
  deploy_service "$service" "$REF"
done
if [ "$UI" = 1 ]; then
  compose --profile ui up -d kafka-ui >/dev/null 2>&1 && ok "Kafka UI: http://localhost:8085"
fi
info "Next: demo/scripts/traffic.sh 50, then demo/scripts/ledger.sh"
