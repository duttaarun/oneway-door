#!/usr/bin/env bash
# Puts the demo back to its starting state, in under a minute once images are built:
#   - main checked out (if the working tree is clean)
#   - images for every demo ref built, so nothing compiles on stage
#   - a fresh stack running v1 from main, with 10 baseline settlements booked
# Usage: reset.sh
source "$(dirname "$0")/lib.sh"

DIR="$(cd "$(dirname "$0")" && pwd)"
REFS="main pr-482-minor-units split/1-expand split/2-migrate split/3-contract split/4-drop"
t0=$(date +%s)

caption "Resetting the demo"
current="$(git -C "$ROOT" symbolic-ref --quiet --short HEAD || echo detached)"
if [ "$current" != main ]; then
  if [ -z "$(git -C "$ROOT" status --porcelain)" ]; then
    git -C "$ROOT" switch -q main && ok "switched from $current to main"
  else
    warn "uncommitted changes on $current; staying there (scripts still deploy by ref)"
  fi
fi

for ref in $REFS; do
  git -C "$ROOT" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || { warn "missing branch $ref"; continue; }
  for service in ledger-service settlement-service reconciliation-batch; do
    build_image "$service" "$ref" >/dev/null || die "could not build $service at $ref"
  done
done
ok "images ready for: $REFS"

"$DIR/down.sh" >/dev/null
"$DIR/up.sh" main | grep -v '^Next:' || die "stack did not start"
"$DIR/traffic.sh" 10
wait_for_drain 30 || warn "baseline not fully booked yet"

ok "reset done in $(( $(date +%s) - t0 ))s. Ready for act 1."
