# One-Way Door

**A GitHub Copilot skill that tells you, before you merge, whether you'll be able to roll back.**

Every pipeline checks that the new code works. None of them asks: *if this goes wrong after deploy, can we actually
roll back?*

A change is a **one-way door** when it leaves behind state that the previous version of the code can't handle: a
migrated table, new-format events on a topic, rewritten cache entries, a payload already sent to a partner. When
that happens, pressing rollback doesn't restore service. It often makes things worse.

One-Way Door reviews a pull request and:

1. classifies each change as **two-way** (safe to roll back) or **one-way** (not safe);
2. says **when the door closes**, **what breaks on rollback** and gives a **safe rollback window**;
3. finds the **blast radius**: other code that reads the same table, column or topic;
4. proposes a **rollback-safe split** (expand → migrate → contract → drop) and can generate it.

It runs in **GitHub Copilot**: VS Code agent mode, Copilot CLI and the Copilot cloud agent.

---

## The £0.00 Settlement

This repo includes Northwind Payments, a small invented payments system: a Spring Boot producer, a Kafka topic, a
Spring Boot consumer that writes a Postgres ledger, and a nightly reconciliation job. Everything below happens for
real when you run `demo/scripts/incident.sh`.

1. **PR #482** moves money from `double` pounds to `long` pence. Migration `V42` renames `ledger_entries.amount` to
   `amount_minor` and multiplies the values by 100. The `PaymentSettled` event swaps `amount` for `amountMinor`.
   Both services are updated. **The tests pass.**
2. It ships. The reconciliation job, which nobody changed, fails: `column "amount" does not exist`.
3. On-call rolls back ledger-service. **v1 won't start**: `Schema-validation: missing column [amount]`. Flyway has
   no undo.
4. Settlements keep coming, in the new format, and queue on Kafka.
5. A DBA reverses V42 by hand. v1 starts and drains the backlog.
6. Jackson ignores the unknown `amountMinor`, and the missing primitive `double amount` stays `0.0`.
   **Fifty settlements are booked at £0.00.** No exception, nothing in the dead-letter topic, every dashboard green.

Rolling back the code didn't roll back the database, or the events already on the topic.

---

## How it works

| Part | Where | What it does |
|---|---|---|
| **Skill** | [`.github/skills/one-way-door/SKILL.md`](.github/skills/one-way-door/SKILL.md) | The procedure Copilot follows: diff from the merge base → bucket files → run the scripts → read the pattern catalogue → search for other readers → reason about old code against new state → write the review. |
| **Scripts** | [`scripts/scan-migrations.mjs`](.github/skills/one-way-door/scripts/scan-migrations.mjs), [`scripts/schema-compat.mjs`](.github/skills/one-way-door/scripts/schema-compat.mjs) | Deterministic, offline, Node 20+ stdlib only, JSON out. They flag destructive DDL in Flyway, Liquibase and EF Core migrations, and breaking JSON Schema changes in the old-reader direction. |
| **Patterns** | [`references/patterns.md`](.github/skills/one-way-door/references/patterns.md) | 24 one-way patterns across data, messages, state and external systems. Each says how to spot it, when the door closes, what breaks, and the safe split. |
| **Format** | [`references/output-format.md`](.github/skills/one-way-door/references/output-format.md) | The exact PR comment: verdict line, numbered findings, blast radius, split. |
| **Rule** | [`.github/instructions/migrations.instructions.md`](.github/instructions/migrations.instructions.md) | Path-specific instructions for migration folders and event contracts: change in steps, never rename, drop or retype in one go, and run the skill before finishing. |
| **Hook** | [`.github/hooks/one-way-door.json`](.github/hooks/one-way-door.json) | A `preToolUse` hook (bash and PowerShell) that stops the agent editing a migration already on the default branch. |
| **Plugin** | [`plugins/one-way-door/`](plugins/one-way-door) | The same skill and hook as an installable Agent Plugins 1.0 package. |

The scripts do the mechanical checks. Copilot, following the skill, does the judgment: who else reads this column,
and what the old code does with the new state. For PR #482, the review opens like this:

```markdown
**Verdict: ONE-WAY** · Safe rollback window: **none** (closes when V42 runs at ledger-service start-up)

1. **Column renamed and converted to pence in place** · `ledger_entries.amount` → `amount_minor` · `V42__amount_minor_units.sql:3`
   - **Door closes:** when ledger-service starts and Flyway runs V42, before it takes traffic.
   - **If rolled back:** v1 fails start-up: `Schema-validation: missing column [amount] in table [ledger_entries]`.
   …
3. **Missing amount silently becomes £0.00** · `PaymentSettled.amount` (ledger-service, `double amount`)
   - **If rolled back:** v1 books the settlement at **£0.00, silently**. No exception, nothing in `payments.settled.DLT`.

### Blast radius
| reconciliation-batch (**not in this PR**) | `Reconcile.java:20` | `SELECT SUM(amount) FROM ledger_entries` | V42 runs |
```

The full example is in [`output-format.md`](.github/skills/one-way-door/references/output-format.md#worked-example-pr-482-mainpr-482-minor-units).

---

## Proof: the rollback tests

The split for PR #482 lives on branches `split/1-expand`, `split/2-migrate`, `split/3-contract` and `split/4-drop`.
It reaches the same end state: the same table, the same event, the same schema.

`demo/scripts/rollback-test.sh <from> <to>` starts clean at *from*, deploys ledger-service and then
settlement-service at *to*, and rolls each back in turn, sending 20 settlements after every step. That covers every
mix of old and new versions. After each stage it checks: both services healthy, every settlement booked once, no
£0.00 rows, an empty dead-letter topic, and a reconciliation total equal to what was sent.

| From | To | Result | First problem |
|---|---|---|---|
| `main` | `split/1-expand` | **PASS** | none |
| `split/1-expand` | `split/2-migrate` | **PASS** | none |
| `split/2-migrate` | `split/3-contract` | **PASS** | none |
| `split/3-contract` | `split/4-drop` | **PASS** | none |
| `main` | `pr-482-minor-units` | **FAIL** | deploying the new ledger-service alone books 20 rows at £0.00 |

PR #482 fails before anyone presses rollback. A new consumer reading old events books zero too. The door is one-way
in both directions. Regenerate the table with `demo/scripts/rollback-matrix.sh` (about 4 minutes). It writes
[`docs/rollback-results.md`](docs/rollback-results.md).

---

## Use it in your repo

**Option 1: copy one folder.** This works in VS Code, Copilot CLI and the cloud agent.

```bash
cp -R path/to/one-way-door/.github/skills/one-way-door  your-repo/.github/skills/
```

Optionally, copy the rule and the hook too. Adjust `applyTo` to your migration paths.

```bash
cp path/to/one-way-door/.github/instructions/migrations.instructions.md your-repo/.github/instructions/
cp -R path/to/one-way-door/.github/hooks your-repo/.github/
```

**Option 2: install the plugin.** This works in VS Code, Copilot CLI and the Copilot app, for every repo you open.

```bash
copilot plugin install OWNER/REPO:plugins/one-way-door
```

In VS Code, set `"chat.plugins.enabled": true`, then run **Chat: Install Plugin From Source** with the repository URL.
The cloud agent doesn't load plugins. Use option 1 there.

Then ask Copilot: *"Review this PR for rollback safety"*, *"Can we roll back main...my-branch?"*, or `/one-way-door`.

**Requirements:** git, and Node.js 20+ for the scripts. Without Node, the skill reads the diff against the catalogue instead.

---

## Run the demo

You need Docker Desktop (the images are multi-arch, so Apple Silicon is fine), Node 20+ and git. Java and Maven
aren't needed on the host, because the builds run in containers.

```bash
demo/scripts/reset.sh            # build images, start Postgres + Kafka + v1, book 10 settlements (~15s once built)
demo/scripts/traffic.sh 50       # 50 settlements = "the last 25 minutes", sent in about a second
demo/scripts/ledger.sh           # last 20 entries, totals, £0.00 count, backlog, DLT, health
demo/scripts/incident.sh         # the £0.00 settlement, end to end (Enter to step; --no-pause to run through)
demo/scripts/rollback-test.sh split/2-migrate split/3-contract
demo/scripts/rollback-matrix.sh  # all five rollback tests and the results table
demo/scripts/down.sh             # stop and delete everything
```

`deploy.sh <service> <ref>` and `rollback.sh <service> <ref>` build any service from any git ref in a git
worktree and restart it. `test.sh <ref>` runs the unit tests at a ref. Add `--ui` to `up.sh` for Kafka UI on
http://localhost:8085.

The 4-minute stage runbook is [`docs/demo-script.md`](docs/demo-script.md). The manual Copilot checks are in
[`docs/copilot-test-checklist.md`](docs/copilot-test-checklist.md).

---

## Tests

```bash
node --test .github/skills/one-way-door/scripts/test/*.test.mjs .github/hooks/scripts/test/*.test.mjs tests/*.test.mjs
demo/scripts/test.sh main        # Java unit tests (in a JDK 21 container)
```

- 31 script tests build throwaway git repos covering Flyway, Liquibase (XML, YAML, formatted SQL), EF Core and JSON Schema.
- 15 hook tests pipe Copilot-shaped and VS Code-shaped payloads into the hook. The PowerShell twin runs where
  `pwsh` exists, including CI.
- 15 repo tests check the SKILL.md rules, catalogue coverage, `applyTo` coverage, and that the plugin is in sync.
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of it, plus each service's unit tests.

---

## Repository layout

```
.github/
  skills/one-way-door/     the deliverable: SKILL.md, references/, scripts/ (+ tests)
  instructions/            migrations.instructions.md (path-specific rule)
  hooks/                   one-way-door.json + bash/PowerShell scripts (+ tests)
  plugin/marketplace.json  makes this repo a one-plugin marketplace
  workflows/               CI and copilot-setup-steps.yml for the cloud agent
plugins/one-way-door/      generated plugin package (node tools/build-plugin.mjs)
contracts/events/          PaymentSettled JSON Schema
demo/                      docker-compose, three services, scripts
docs/                      copilot-formats.md, demo-script.md, copilot-test-checklist.md, rollback-results.md, progress.md
tests/                     repo-level consistency tests
```

## Limits

- The scripts parse SQL (Postgres, MySQL and SQL Server dialects), Liquibase, EF Core and JSON Schema. Avro,
  Protobuf, caches, idempotency keys and external systems are covered by the catalogue and the agent's judgment, not
  by scripts.
- VS Code hooks are in preview. Whether the Copilot CLI expands `${PLUGIN_ROOT}` in plugin hook commands isn't
  documented. If it doesn't, the plugin's hook allows rather than blocks. The in-repo hook doesn't depend on it.
- The checklist in `docs/copilot-test-checklist.md` still has to be run by hand in each Copilot surface.

Northwind Payments, its merchants and all amounts are invented.
