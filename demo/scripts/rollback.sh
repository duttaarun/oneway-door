#!/usr/bin/env bash
# Rolls one service back to an earlier git ref. Same mechanics as deploy.sh: the old
# code really is rebuilt from git and restarted against today's database and topic.
# Usage: rollback.sh <service> <git-ref>
[ $# -eq 2 ] || { sed -n '2,4p' "$0"; exit 2; }
ACTION="Rolling back" exec "$(dirname "$0")/deploy.sh" "$@"
