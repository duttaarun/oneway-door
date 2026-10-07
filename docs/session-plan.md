# One-Way Door: Claude Code session plan

Paste each phase's prompt into Claude Code, in order. Run `/clear` between phases, because `CLAUDE.md` and `docs/progress.md` carry the context forward. Each phase ends with a commit.

**Setup**
1. Create an empty repo called `one-way-door`.
2. Drop `CLAUDE.md` into the repo root.
3. Open the repo in Claude Code.

Phases 1–2 build the demo, 3–5 build the skill, 6 adds the rule and hook, 7–8 prepare you for the stage. If time gets tight, Phase 6 is the one to cut.

---

## Phase 0: Verify the Copilot formats (about 15 min)

```
Read CLAUDE.md. Then fetch the four Copilot/VS Code doc URLs listed under
"Hard rules" and write docs/copilot-formats.md. It should be a concise,
verified reference covering:
- Agent skill location, SKILL.md frontmatter fields and naming rules, and
  how references/ and scripts/ are used
- Path-specific custom instructions: the .github/instructions/*.instructions.md
  location and applyTo syntax
- Hook file location, JSON schema, available events, the stdin payload for
  preToolUse, and the exact deny output
- Anything that differs between VS Code agent mode, Copilot CLI and the
  cloud agent
Quote nothing longer than a short phrase; paraphrase. Flag anything the docs
leave unclear. Don't write any other code yet.
```

**Done when:** `docs/copilot-formats.md` exists and you've skimmed it. Fix anything that looks off now, because every later phase builds on it.

---

## Phase 1: The happy path, v1 on `main` (about 60–90 min)

```
Plan mode. Build the v1 demo on main, as described under "The demo story"
in CLAUDE.md:
- demo/docker-compose.yml: Postgres 16, Kafka in KRaft single-node mode,
  optional Kafka UI. Everything arm64-compatible.
- settlement-service (Spring Boot 3, Java 21): POST /settlements publishes
  PaymentSettled { paymentId, merchantId, currency, double amount, settledAt }
  to topic payments.settled. Disable type headers.
- ledger-service: consumes payments.settled and writes ledger_entries via
  Flyway V1. Uses amount numeric(12,2), ddl-auto=validate and a fixed default
  consumer type. Configure a dead-letter topic (payments.settled.DLT).
- reconciliation-batch: a tiny main() that runs SELECT SUM(amount) FROM
  ledger_entries and prints it.
- contracts/events/payment-settled.schema.json matching v1.
- demo/scripts: up.sh, down.sh, traffic.sh <count> (fires N settlements fast),
  ledger.sh (shows the last 20 entries + row count + DLT count).
Show me the plan first.
```

**Done when:** `up.sh` then `traffic.sh 50` then `ledger.sh` shows 50 rows with correct amounts, and the DLT is empty.

---

## Phase 2: The bad PR and a real incident (about 60–90 min)

```
Plan mode. Create branch pr-482-minor-units from main containing "PR #482":
V42__amount_minor_units.sql (rename + retype in place, exactly as in
CLAUDE.md), PaymentSettled changed to long amountMinor (amount removed),
both services updated, schema file updated, and existing tests passing.

Then build demo/scripts:
- deploy.sh <service> <git-ref>: builds that service from a git worktree at
  that ref and restarts its container. Real code, real rollback.
- rollback.sh <service> <git-ref>: same mechanics, clearer name for the demo.
- hotfix-reverse-v42.sql + apply-hotfix.sh.
- incident.sh: runs the whole story end to end with pauses and plain-English
  captions. Deploy v2 → traffic → roll back ledger-service only → show the
  crash → apply hotfix → v1 drains the backlog → ledger.sh shows £0.00 rows,
  an empty DLT and a green health endpoint.
Back to main afterwards.
```

**Done when:** `incident.sh` reliably ends with £0.00 rows, an empty DLT and a healthy ledger-service. Run it three times from a clean `down.sh`.

---

## Phase 3: The skill brain, SKILL.md and the pattern catalogue (about 60 min)

```
Plan mode. Write .github/skills/one-way-door/ per docs/copilot-formats.md:

1. references/patterns.md: a catalogue of one-way patterns, grouped as
   Data / Messages / State / External. For each pattern give: how to spot it
   in a diff, when the door closes, what breaks on rollback (old code + new
   state), and the safe split.
   Must include: column rename/drop/retype, NOT NULL backfill, in-place data
   conversion (information loss), event field removal/rename/retype, new enum
   value, new field vs consumers with FAIL_ON_UNKNOWN_PROPERTIES, missing
   primitive defaulting to 0, cache/serialisation format change,
   idempotency-key format change, Service Bus queue/subscription deletion,
   APIM version removal, partner webhook payload change, and
   editing an already-applied migration.

2. references/output-format.md: the exact PR comment format. Verdict line
   with ONE-WAY/TWO-WAY and the safe rollback window, numbered findings
   (door closes / if rolled back / data loss), blast radius, and the
   suggested split with an offer to generate it.

3. SKILL.md: a trigger-rich description, then a step-by-step procedure:
   get the diff vs base → bucket the changed files → run both scripts →
   read patterns.md for anything the scripts flag or can't cover → search the
   repo for other readers of each touched table/column/topic → reason about
   old code vs new state → write the comment per output-format.md →
   if asked, generate the split as branches/PRs.
   Keep it under 500 lines.

Use PR #482 as the worked example inside the references, not in SKILL.md.
```

**Done when:** the SKILL.md frontmatter matches the rules, and reading patterns.md teaches you something.

---

## Phase 4: Deterministic scripts + tests (about 60–90 min)

```
Plan mode. Build the two scripts in .github/skills/one-way-door/scripts/
(Node 20+, stdlib only, JSON on stdout, always exit 0):

1. scan-migrations.mjs --base <ref> --head <ref>
   Finds migration files added/changed between refs (Flyway V*.sql,
   Liquibase changelogs, EF Migrations/*.cs). Flags destructive or
   rollback-hostile DDL: RENAME COLUMN/TABLE, DROP COLUMN/TABLE,
   ALTER ... TYPE, SET NOT NULL, UPDATE in a migration (in-place conversion),
   and edits to files that already exist on base.
   For each finding output: file, line, pattern id (matching patterns.md),
   object (table.column) and severity.

2. schema-compat.mjs --base <ref> --head <ref> [--dir contracts/events]
   Diffs each JSON Schema between refs in the OLD-READER direction
   ("can v1 consumers read events v2 produces?"): required field removed,
   field renamed (removed+added in the same change), type changed, enum value
   added, new required field. Output findings with pattern ids.

Write node:test suites with fixture repos (create small temp git repos in the
tests). Run them and show me the output. Then run both scripts against
main..pr-482-minor-units and show me the JSON.
```

**Done when:** the tests are green and the PR #482 run flags V42 (rename, retype, in-place conversion) and the event change (field removed, field added).

---

## Phase 5: The split, and proof it works (about 60–90 min)

```
Plan mode. Two parts:

1. Create branches split/1-expand, split/2-migrate, split/3-contract and
   split/4-drop from main. Together they reach the same end state as
   pr-482-minor-units, following the safe split in patterns.md. PR 2 includes
   a backfill and a check that amount and amount_minor agree. PR 3 also moves
   reconciliation-batch to amount_minor.

2. demo/scripts/rollback-test.sh <from-ref> <to-ref>: deploy to-ref, send
   traffic, roll back to from-ref, send traffic again, then assert: all
   services healthy, no £0.00 rows, DLT empty, reconciliation total correct.
   Print a clear PASS/FAIL.

Run it for main→1, 1→2, 2→3, 3→4 (each should PASS) and for
main→pr-482-minor-units (should FAIL). Show me the results table.
```

**Done when:** four PASSes and one FAIL. That table goes straight onto a pitch slide.

---

## Phase 6: Rule + hook (optional, about 45 min)

```
Plan mode. Per docs/copilot-formats.md:

1. .github/instructions/migrations.instructions.md with applyTo covering
   migration folders and contracts/events/**. It tells Copilot to follow
   expand → migrate → contract → drop and never rename/drop/retype in one
   step, and to run the one-way-door skill before finishing any change there.

2. .github/hooks/one-way-door.json + scripts (bash and PowerShell):
   a preToolUse hook that denies an agent edit to a migration file that
   already exists on the default branch (editing an applied migration is a
   one-way door). Use the documented deny output with a clear reason.
   Write a test that pipes sample preToolUse JSON into the script.
```

**Done when:** the hook test passes and the instruction file's `applyTo` matches the right paths.

---

## Phase 7: Test in Copilot itself (about 45 min, by hand)

Claude Code built it. Copilot has to run it. Ask Claude Code for a checklist, then do it yourself:

```
Write docs/copilot-test-checklist.md: step-by-step manual tests for
(a) VS Code agent mode, (b) Copilot CLI interactive and (c) the Copilot cloud
agent on a GitHub PR. For each: how to confirm the skill was discovered and
loaded, the exact prompt to use against pr-482-minor-units, what a good
result looks like, and what to tweak in the SKILL.md description if it
doesn't trigger.
```

Then run the checklist yourself in VS Code and Copilot CLI. If the skill doesn't trigger reliably, bring the transcript back to Claude Code and tune the `description`.

---

## Phase 8: Stage-ready (about 45 min)

```
1. README.md: pitch-quality. Use the one-liner, the problem, "The £0.00
   Settlement", how it works (skill + scripts + rule + hook), the
   rollback-test results table, and how to use it in any repo (copy one
   folder).
2. docs/demo-script.md: the 4-minute runbook. Five acts (innocent PR →
   incident → rewind and run the skill → split → proof), the exact commands
   and Copilot prompts for each, what to say, and a fallback for each step
   if something fails live.
3. demo/scripts/reset.sh: puts everything back to the starting state in
   under a minute.
```

Record a full run as a backup video. Live demos fail, and a recording means you still have something to show.

---

## Tips for the session

- **One phase per session.** `/clear` between phases keeps Claude Code sharp. `docs/progress.md` is its memory.
- **Make it prove things.** Every "Done when" is a command it should run and show you, not a claim.
- **Protect the deliverable.** If Claude Code proposes `.claude/` paths or Claude-format hooks for the Copilot files, point it back to `docs/copilot-formats.md`.
- **Time box.** Phases 0–5 give you a complete, winning demo.
