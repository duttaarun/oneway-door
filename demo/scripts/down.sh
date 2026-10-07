#!/usr/bin/env bash
# Stops everything and deletes all demo data (database, topics, traffic log).
source "$(dirname "$0")/lib.sh"

compose --profile batch --profile ui down -v --remove-orphans >/dev/null 2>&1 || true
rm -f "$SENT_FILE" "$STATE"/deployed/*
rm -rf "$STATE/worktrees"; git -C "$ROOT" worktree prune
ok "demo stopped and data removed"
