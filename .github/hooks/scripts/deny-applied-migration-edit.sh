#!/usr/bin/env bash
# one-way-door preToolUse hook: blocks agent edits to database migrations that already exist on the
# default branch. Editing an applied migration is a one-way door: every environment that already ran
# it keeps the old version, so the edit never reaches them.
#
# Reads the hook payload on stdin, in either shape:
#   Copilot (camelCase):        { "toolName": "edit", "toolArgs": { "path": "…" }, "cwd": "…" }
#   VS Code / PascalCase:       { "tool_name": "Edit", "tool_input": { "file_path": "…" }, "cwd": "…" }
# Prints {} to allow, or a deny decision in both the Copilot and the VS Code shape.
#
# Always exits 0. A preToolUse hook that errors denies *every* tool call, so when in doubt this allows.
# Needs only bash (3.2+), git, grep and sed. Override the base branch with ONE_WAY_DOOR_BASE.

allow() { printf '{}\n'; exit 0; }

payload="$(cat 2>/dev/null)" || allow
[ -n "$payload" ] || allow
# toolArgs can arrive as a JSON string. Unescape one level so both shapes look alike.
flat="$(printf '%s' "$payload" | sed 's/\\"/"/g; s/\\\\/\\/g')"

field() { # first string value of any of the given keys, from $flat
  printf '%s' "$flat" | grep -oE "\"($1)\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"(.*)"$/\1/'
}

tool="$(field 'toolName|tool_name')"
tool_lc="$(printf '%s' "$tool" | tr 'A-Z' 'a-z')"
case "$tool_lc" in
  *bash*|*shell*|*powershell*|*terminal*|*run_in*|*exec*) kind=shell ;;
  *edit*|*write*|*create*|*replace*|*patch*|*insert*|*delete*|*remove*|*rename*|*move*|*multi*) kind=edit ;;
  *) allow ;;
esac
# str_replace_editor-style tools also read files; reading is always fine.
[ "$kind" = edit ] && [ "$(field 'command')" = view ] && allow

cwd="$(field 'cwd')"
if [ -n "$cwd" ] && [ -d "$cwd" ]; then cd "$cwd" 2>/dev/null || true; fi
root="$(git rev-parse --show-toplevel 2>/dev/null)" || allow
cd "$root" 2>/dev/null || allow

base="${ONE_WAY_DOOR_BASE:-}"
if [ -z "$base" ]; then
  base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  for b in origin/main main origin/master master; do
    [ -n "$base" ] && break
    git rev-parse --verify --quiet "$b^{commit}" >/dev/null 2>&1 && base="$b"
  done
fi
[ -n "$base" ] || allow
git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || allow

# Migration formats whose files must never change once applied. Liquibase changelogs are left out on
# purpose: appending a changeSet to an existing file is normal (scan-migrations checks changeSets).
immutable_migration() {
  case "$1" in
    *.Designer.cs|*ModelSnapshot.cs) return 1 ;;
    Migrations/*.cs|*/Migrations/*.cs) return 0 ;;
  esac
  case "${1##*/}" in
    [Rr]__*.sql|[Uu][0-9]*__*.sql) return 1 ;;   # repeatable and undo scripts are meant to change
    [Vv][0-9]*__*.sql) return 0 ;;
  esac
  case "$1" in
    db/migration/*.sql|*/db/migration/*.sql|migrations/*.sql|*/migrations/*.sql) return 0 ;;
  esac
  return 1
}

relative() { # absolute, file:// or ./ path -> repo-relative path
  local p="${1#file://}" lp prefix lprefix
  # Windows: editors send C:\repo\... or c:/repo/..., git says C:/repo. File URIs look like /C:/repo/...
  p="$(printf '%s' "$p" | tr '\\' '/')"
  case "$p" in /[A-Za-z]:/*) p="${p#/}" ;; esac
  # Compare without case: Windows and macOS paths are case-insensitive, and the editor's spelling of the root
  # (c: or C:) need not match git's. macOS temp folders also appear with and without /private.
  lp="$(printf '%s' "$p" | tr 'A-Z' 'a-z')"
  for prefix in "$root/" "/private$root/" "${root#/private}/"; do
    lprefix="$(printf '%s' "$prefix" | tr 'A-Z' 'a-z')"
    case "$lp" in "$lprefix"*) p="${p:${#prefix}}"; break ;; esac
  done
  printf '%s' "${p#./}"
}

deny() { # repo-relative path
  local path="$1" dir next advice reason escaped
  dir="$(dirname "$path")"
  case "${path##*/}" in
    [Vv][0-9]*)
      next="$(git ls-tree --name-only "$base" "$dir/" 2>/dev/null | sed -nE 's#.*/[Vv]([0-9]+)__.*#\1#p' | sort -n | tail -1)"
      advice="Add a new migration instead, e.g. $dir/V$(( ${next:-0} + 1 ))__<what_changes>.sql."
      ;;
    *.cs) advice="Add a new migration instead (dotnet ef migrations add <Name>); EF Core never re-runs an applied one." ;;
    *) advice="Add a new migration instead." ;;
  esac
  reason="one-way-door: $path is already on $base, so it has probably run somewhere. Editing an applied migration is a one-way door: environments that ran it never see the edit, and Flyway refuses to start on the checksum mismatch. $advice"
  escaped="$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"permissionDecision":"deny","permissionDecisionReason":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$escaped" "$escaped"
  exit 0
}

on_base() { git cat-file -e "$base:$1" 2>/dev/null; }

if [ "$kind" = edit ]; then
  candidates="$(
    printf '%s' "$flat" \
      | grep -oE '"(path|file_path|filePath|filepath|file|filename|fileName|target_file|targetFile|uri|old_path|new_path|oldPath|newPath|source|destination)"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"(.*)"$/\1/'
    printf '%s' "$flat" \
      | grep -oE '"(files|paths|filePaths|file_paths)"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
      | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*//' | grep -oE '"[^"]*"' | tr -d '"'
    printf '%s' "$flat" | grep -oE '\*\*\* (Update|Delete|Move) File: [^\\"]*' | sed -E 's/^\*\*\* [A-Za-z]+ File: //'
    printf '%s' "$flat" | grep -oE '(\+\+\+|---) a/[^\\" ]*' | sed -E 's#^(\+\+\+|---) a/##'
  )"
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    rel="$(relative "$candidate")"
    immutable_migration "$rel" && on_base "$rel" && deny "$rel"
  done <<EOF
$candidates
EOF
  allow
fi

# Shell tools: deny only a command that both writes and names an applied migration.
command="$(printf '%s' "$payload" | grep -oE '"(command|cmd|script|commandLine)"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | head -1 \
  | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//; s/\\"/"/g')"
[ -n "$command" ] || allow
printf '%s' "$command" | grep -qE '(sed[[:space:]]+(-[a-zA-Z]*i|--in-place)|perl[[:space:]]+-[a-zA-Z]*i|[^0-9&]>>?[[:space:]]*[^&[:space:]]|(^|[;&|[:space:]])(tee|rm|mv|cp|truncate|unlink)[[:space:]]|git[[:space:]]+(mv|rm|checkout)[[:space:]])' || allow
while IFS= read -r file; do
  immutable_migration "$file" || continue
  case "$command" in *"${file##*/}"*) deny "$file" ;; esac
done <<EOF
$(git ls-tree -r --name-only "$base" 2>/dev/null)
EOF
allow
