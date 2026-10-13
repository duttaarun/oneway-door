# Copilot test checklist

Claude Code built the deliverable. These manual tests check that **GitHub Copilot** finds and runs it. Do them in
order: VS Code agent mode, then Copilot CLI, then the cloud agent. Tick each box and note anything odd in
`docs/progress.md`.

Formats and setting names come from `docs/copilot-formats.md`, checked against the live docs on 7 October 2026.

## Before you start

- [ ] `git branch --list 'pr-482-minor-units' 'split/*'` shows all five branches.
- [ ] All node tests are green:
      ```bash
      node --test .github/skills/one-way-door/scripts/test/*.test.mjs .github/hooks/scripts/test/*.test.mjs tests/*.test.mjs
      ```
- [ ] The scripts flag PR #482 (3 + 5 findings):
      ```bash
      node .github/skills/one-way-door/scripts/scan-migrations.mjs --base main --head pr-482-minor-units
      node .github/skills/one-way-door/scripts/schema-compat.mjs --base main --head pr-482-minor-units
      ```
- [ ] Node 20+ is on PATH. The skill needs it for its scripts.

### The prompts

Use these exact prompts everywhere, so the results are comparable.

| # | Prompt | Tests |
|---|---|---|
| P1 | `Review the pr-482-minor-units branch against main. If this goes wrong after deploy, can we roll back?` | Automatic triggering, wording 1 |
| P2 | `Is pr-482-minor-units safe to release?` | Automatic triggering, wording 2 (release readiness) |
| P3 | `/one-way-door main...pr-482-minor-units` | Explicit invocation (bypasses the description) |
| P4 | `Generate the split.` (after P1 or P3) | Step 8 of the procedure |
| P5 | `Review split/2-migrate...split/3-contract for rollback safety.` | A TWO-WAY result |

### What a good result looks like (P1, P2, P3)

Compare it with the worked example in `.github/skills/one-way-door/references/output-format.md`:

- [ ] It ran `scan-migrations.mjs` **and** `schema-compat.mjs` (look for both commands in the tool calls).
- [ ] The first line is `**Verdict: ONE-WAY** · Safe rollback window: **none** …`.
- [ ] The findings cover, at least:
  1. V3 rename plus in-place conversion to pence (`column-rename`, `column-retype`, `in-place-conversion`), with
     the door closing when ledger-service starts.
  2. `amount` replaced by `amountMinor` in `PaymentSettled` (`event-field-removed`, `event-field-renamed`, …).
  3. **Silent £0.00** from the primitive `double amount` (`missing-primitive-default`), with "no exception, nothing
     in the DLT".
- [ ] The blast radius names **reconciliation-batch** (`Reconcile.java`, `SUM(amount)`) as **not in this PR**.
- [ ] The suggested split has 4 rows (expand, migrate, contract, drop) and ends with the "generate the split" offer.
- [ ] The tone is British English, short sentences, no emoji.

If it misses reconciliation-batch, the skill skipped step 5. Check that the SKILL.md procedure was loaded (below).

---

## A. VS Code agent mode

Setup:

- [ ] Open the repo folder in VS Code and trust the workspace (hooks and skills need Workspace Trust).
- [ ] Open Chat and pick **Agent** mode.
- [ ] `git switch main`. The skill lives on every branch, but start from main.

Is the skill found?

- [ ] Type `/` in the chat box. `one-way-door` must appear in the list.
- [ ] Or run **Chat: Open Customizations** from the Command Palette and look under Skills.
- [ ] If it's missing: check `name:` in SKILL.md equals the folder name `one-way-door`. VS Code drops skills with a
      bad name **silently**. Check that `.github/skills/one-way-door/SKILL.md` is in the workspace root you opened.

Run it:

- [ ] P1 in a new chat. Expand **References** under the answer. `SKILL.md` from `one-way-door` should be listed,
      and later `references/patterns.md` and `references/output-format.md` once it reads them.
- [ ] P2 in a new chat. The same skill should trigger.
- [ ] P3. The skill is forced, so this checks the procedure even if triggering is weak.
- [ ] P5. You should get `TWO-WAY` and a `### Checked` list, with no split table.

Path instructions (`migrations.instructions.md`):

- [ ] Ask: `Add a column 'fee_minor' to ledger_entries.` When the agent creates a migration under
      `demo/ledger-service/src/main/resources/db/migration/`, **References** should list
      `migrations.instructions.md`. The agent should add a **new** `V<n>__` file, keep the column nullable, and
      mention the one-way-door check.

Hook (`.github/hooks/one-way-door.json`):

- [ ] Ask: `Change V1__create_ledger_entries.sql so merchant_id is varchar(128).`
- [ ] The edit must be **blocked** with a message starting `one-way-door: … is already on main`, which suggests a
      new `V<n>__` file. The agent should then write a new migration instead.
- [ ] If it isn't blocked, open the **Output** panel, choose the hooks or agent debug log, and check that the hook
      ran, which tool name it got, and what it printed. VS Code reads `hookSpecificOutput.permissionDecision`, and
      the script prints both shapes.

---

## B. Copilot CLI (interactive)

Setup:

- [ ] Install or update the CLI (`copilot --version`) and run `copilot` from the repo root.

Is the skill found?

- [ ] `/skills list` shows `one-way-door` with its description.
- [ ] `/skills info` shows it loaded from `.github/skills/one-way-door`.
- [ ] If you edited SKILL.md during the session, run `/skills reload`.

Run it:

- [ ] P1, P2 and P3 as above. The CLI shows each shell command before it runs. Approve the two `node …mjs` commands
      and the `git grep`/`git diff` commands. (Don't add `allowed-tools` to SKILL.md to skip this. The docs warn it
      removes the confirmation step.)
- [ ] P4 `Generate the split.` It should create local `split/…` branches (or say they already exist) and **not**
      push or open PRs unless you ask.
- [ ] P5 gives TWO-WAY.

Hook:

- [ ] Ask the CLI to edit `V1__create_ledger_entries.sql`. The tool call is denied with the one-way-door reason.
- [ ] Ask it to run `sed -i 's/64/128/' demo/ledger-service/src/main/resources/db/migration/V1__create_ledger_entries.sql`.
      That is denied too.
- [ ] Ask it to read the file. That is allowed.

Plugin route (the "pluggable" install, in a **different** repo):

- [ ] In any other git repo: `copilot plugin install /absolute/path/to/one-way-door/plugins/one-way-door`
      (or `OWNER/REPO:plugins/one-way-door` once pushed).
- [ ] `copilot plugin list` shows `one-way-door`. `/skills list` in a session shows the skill from the plugin.
- [ ] Ask an edit of an applied migration in that repo. If the hook doesn't fire, the CLI may not expand
      `${PLUGIN_ROOT}` in plugin hook commands, which the docs don't settle. The command then allows by design.
      Note the result in `docs/copilot-formats.md`.
- [ ] Afterwards: `copilot plugin uninstall one-way-door`.

---

## C. Copilot cloud agent on a GitHub PR

Setup (needs a GitHub repo you own, with Copilot cloud agent enabled):

- [ ] Push `main`, `pr-482-minor-units` and the four `split/*` branches.
- [ ] Make sure `.github/workflows/copilot-setup-steps.yml` is on the default branch. It only runs from there.
- [ ] Open a PR from `pr-482-minor-units` into `main` titled "PR #482: store settlement amounts in minor units".
      CI should go **green**. That is the point: tests can't see one-way doors.

Run it:

- [ ] In the PR, ask Copilot (mention `@copilot` in a comment or assign it):
      `@copilot Review this PR for rollback safety. If it goes wrong after deploy, can we roll back? Post the result as a comment.`
- [ ] Open the agent session log. Check that it read `.github/skills/one-way-door/SKILL.md` and ran both scripts
      (the setup steps installed Node 20 and fetched `main`).
- [ ] The comment matches the format: verdict line, numbered findings, blast radius with reconciliation-batch, and
      the split offer.
- [ ] Hook: ask `@copilot Fix the precision by editing V1__create_ledger_entries.sql`. In the session log the edit
      is denied with the one-way-door reason. The cloud agent only reads `.github/hooks/*.json`, and only the `bash`
      command.

---

## If the skill doesn't trigger

Copilot only reads `name` and `description` when it decides whether to load a skill. Change one thing at a time,
then re-run P1 and P2 in a **new** chat (`/skills reload` in the CLI).

| Symptom | Tweak in the SKILL.md `description` |
|---|---|
| "Review this PR" gets a generic code review | Put the trigger first: start with `Use for every pull request review and before any deploy or release.` |
| "Can we roll back?" doesn't trigger | Add the exact phrasings: `rollback`, `roll back`, `revert`, `undo a deploy`. |
| Triggers on PRs but not on "safe to release?" | Add `release readiness`, `go/no-go`, `ship`, `deploy checklist`. |
| Triggers for migrations but not for event changes | Name the formats people type: `Kafka topic`, `event payload`, `DTO`, `Avro`, `contract`. |
| Triggers too often (every code question) | Drop generic words like `changes` and keep the rollback, deploy and migration ones. |
| Explicit `/one-way-door` works but nothing else does | The description is probably fine, so check the length: it must be at most 1024 characters, and the agent may favour shorter, sharper ones. Cut the "what it does" half before the "when to use" half. |

After any change:

- [ ] `node --test tests/skill.test.mjs` (frontmatter rules and length).
- [ ] `node tools/build-plugin.mjs` to refresh the plugin copy, and commit both.
- [ ] Write the before and after wording, and the result, in `docs/progress.md`.
