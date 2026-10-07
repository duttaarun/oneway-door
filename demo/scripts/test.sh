#!/usr/bin/env bash
# Runs the unit tests of every service at a git ref, in a worktree, inside a JDK 21 container.
# Usage: test.sh [git-ref]   (default: main)
source "$(dirname "$0")/lib.sh"

REF="${1:-main}"; COMMIT="$(resolve_commit "$REF")"
WT="$STATE/worktrees/test-${COMMIT:0:12}"
rm -rf "$WT"; git -C "$ROOT" worktree prune
git -C "$ROOT" worktree add --quiet --detach "$WT" "$COMMIT"
trap 'git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT

caption "Unit tests at $REF (${COMMIT:0:7})"
status=0
for service in settlement-service ledger-service reconciliation-batch; do
  out="$(docker run --rm -v "$WT/demo/$service":/src -v owd-m2:/root/.m2 -w /src \
         eclipse-temurin:21-jdk ./mvnw -B test 2>&1 || true)"
  summary="$(printf '%s\n' "$out" | grep -E '^\[(INFO|ERROR|WARNING)\] Tests run:' | tail -1 | sed -E 's/^\[[A-Z]+\] //' || true)"
  if printf '%s\n' "$out" | grep -c 'BUILD SUCCESS' >/dev/null; then
    ok "$service: ${summary:-no tests}"
  else
    fail "$service: ${summary:-build failed}"; status=1
    printf '%s\n' "$out" | grep -E 'ERROR|FAIL' | head -10
  fi
done
exit $status
