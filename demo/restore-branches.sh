#!/bin/sh
# Recreates the demo's git branches when the project arrives as a zip. A zip has no .git folder (or only main),
# but the demo needs main and the six demo branches, with their history. demo/branches.bundle carries them.
# Usage: sh demo/restore-branches.sh   from anywhere, any number of times (it never moves an existing branch)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
bundle="$here/branches.bundle"
BRANCHES="main pr-482-minor-units split/1-expand split/2-migrate split/3-contract split/4-drop"
cd "$root"

fail() { echo "Restore stopped: $1" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail "git isn't installed or isn't on PATH."
[ -f "$bundle" ] || fail "$bundle is missing. Copy it from the original project."

fresh=no
if [ ! -e .git ]; then
  echo "No git repository here (a zip has none). Creating one."
  git init -q
  git symbolic-ref HEAD refs/heads/main
  fresh=yes
elif ! git rev-parse --verify -q HEAD >/dev/null; then
  git symbolic-ref HEAD refs/heads/main     # an empty repository: main becomes its first branch
  fresh=yes
fi
git bundle verify -q "$bundle" >/dev/null 2>&1 || fail "$bundle is damaged. Copy it again."

if [ "$fresh" = yes ]; then
  # main comes from the bundle, so it keeps its history; the files stay exactly as they came in the zip.
  git fetch -q --update-head-ok "$bundle" refs/heads/main:refs/heads/main
  git reset -q
  # A zip can drop the executable bit. Put it back wherever git records it.
  git ls-files -s | awk -F '\t' '$1 ~ /^100755 / { print $2 }' | while IFS= read -r f; do
    [ -f "$f" ] && chmod +x "$f"
  done
  git -c core.safecrlf=false add -A
  if ! git diff --cached --quiet; then
    msg="Restore: the files from the zip, on top of the bundled history"
    if git config user.email >/dev/null; then git commit -q -m "$msg"
    else git -c user.name="One-Way Door restore" -c user.email="restore@localhost" commit -q -m "$msg"; fi
    echo "Committed what the zip has beyond the bundled main:"
    git show --stat --format= HEAD | tail -n 1
  fi
fi

echo "Branches:"
for b in $BRANCHES; do
  if git show-ref --verify -q "refs/heads/$b"; then
    echo "  ok  $b, already here"
  elif git show-ref --verify -q "refs/remotes/origin/$b"; then
    git branch -q --track "$b" "origin/$b"
    echo "  +   $b, from origin"
  else
    git fetch -q "$bundle" "refs/heads/$b:refs/heads/$b"
    echo "  +   $b, from the bundle"
  fi
done

echo
git for-each-ref --format='  %(refname:short)  %(objectname:short)  %(subject)' refs/heads/
echo
echo "Done. Next: sh demo/start.sh"
