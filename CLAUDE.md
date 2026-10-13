# One-Way Door: hackathon project

## What we're building

**One-Way Door** is a reusable **GitHub Copilot Agent Skill**. On every pull request it answers the question no pipeline asks: *"If this goes wrong after deploy, can we actually roll back?"*

A change is a **one-way door** when it leaves behind state that the previous version of the code can't handle. Examples are migrated tables, new-format events in a topic, rewritten cache entries and payloads already sent to partners. When that happens, pressing rollback doesn't restore service, and it often makes things worse.

The skill reviews a PR diff and does four things:
1. Classifies each change as **two-way** (safe to roll back) or **one-way** (not safe).
2. For each one-way change, says **when the door closes** and **what breaks on rollback**, and gives a **safe rollback window**.
3. Finds the **blast radius**: other code that reads the same table, column or topic.
4. Proposes a **rollback-safe split** (expand → migrate → contract → drop) and can generate it.

The **deliverable runs in GitHub Copilot**: VS Code agent mode, Copilot CLI and the Copilot cloud agent. We build it with Claude Code. That means every deliverable file must use **Copilot's** formats and locations, not Claude Code's.

## Repository layout (target)

```
.
├── CLAUDE.md
├── README.md                          # pitch-quality overview
├── .github/
│   ├── skills/one-way-door/           # THE DELIVERABLE
│   │   ├── SKILL.md
│   │   ├── references/
│   │   │   ├── patterns.md            # one-way pattern catalogue + safe split for each
│   │   │   └── output-format.md       # exact PR comment format
│   │   └── scripts/
│   │       ├── scan-migrations.mjs    # destructive DDL in Flyway/Liquibase/EF migrations
│   │       ├── schema-compat.mjs      # event schema diff, base vs head, old-reader direction
│   │       └── test/                  # node:test suites + fixtures
│   ├── instructions/
│   │   └── migrations.instructions.md # path-specific rule (applyTo: migrations + event contracts)
│   └── hooks/                         # optional, Phase 6
│       ├── one-way-door.json
│       └── scripts/
├── contracts/events/
│   └── payment-settled.schema.json    # JSON Schema for the PaymentSettled event
├── demo/
│   ├── docker-compose.yml             # Postgres + Kafka (KRaft, single node) + optional Kafka UI
│   ├── settlement-service/            # Spring Boot producer → topic payments.settled
│   ├── ledger-service/                # Spring Boot consumer → Postgres ledger_entries (Flyway)
│   ├── reconciliation-batch/          # tiny job that reads ledger_entries.amount directly (blast-radius target)
│   └── scripts/                       # deploy.sh, rollback.sh, traffic.sh, ledger.sh, rollback-test.sh
└── docs/
    ├── copilot-formats.md             # verified current Copilot formats (written in Phase 0)
    ├── demo-script.md                 # the 4-minute live demo runbook
    └── progress.md                    # running log: what's done, what's next, gotchas
```

## Hard rules for deliverable files

**Do not rely on memory for Copilot formats.** They change often. Use `docs/copilot-formats.md`, which we write in Phase 0 from the live docs:
- Skills: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-skills
- Skill guidelines: https://awesome-copilot.github.com/instruction/agent-skills/
- Hooks: https://docs.github.com/en/copilot/reference/hooks-reference
- VS Code hooks: https://code.visualstudio.com/docs/agent-customization/hooks

**Skill rules**
- SKILL.md frontmatter `name` must exactly equal the folder name (`one-way-door`).
- `description` is the only thing Copilot reads when deciding whether to load the skill. It must name the triggers: PR review, deploy or release readiness, migrations, schema/event changes, "can we roll back".
- Keep the SKILL.md body under 500 lines. Put detail in `references/` and tell the agent when to read each file.

**Hook rules**
- Hooks go in `.github/hooks/*.json`, in **Copilot** format: `{"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"...","powershell":"...","timeoutSec":N}]}}`.
- To block, exit 0 and print `{"permissionDecision":"deny","permissionDecisionReason":"..."}` on stdout.
- Never put deliverable hooks in `.claude/settings.json`.

**Script rules**
- Scripts must be deterministic, offline and Node 20+ stdlib only, with no npm dependencies.
- Output machine-readable JSON on stdout, and exit 0 even when findings exist. Findings are data, not errors.
- Scripts do the mechanical checks. The agent, following SKILL.md, does the judgment: blast radius, plain-English explanation and the split.

## The demo story: "The £0.00 Settlement"

- **v1 (`main`):** `PaymentSettled { double amount }`. ledger-service writes `ledger_entries.amount numeric(12,2)`.
- **The bad PR (branch `pr-482-minor-units`):**
  - Flyway `V3__amount_minor_units.sql` renames `amount` → `amount_minor` and retypes it to `bigint USING (amount_minor * 100)::bigint`.
  - The event changes to `long amountMinor`, and `amount` is removed.
  - Both services are updated.
  - Tests pass. It looks like a good refactor.
- **The incident, reproduced for real:**
  1. Deploy both v2 services. V3 runs.
  2. Roll back **ledger-service only** to v1. It fails because `column "amount" does not exist`.
  3. Apply `demo/scripts/hotfix-reverse-v3.sql`. v1 comes back up.
  4. v1 consumes the backlog of v2 events. Jackson ignores the unknown `amountMinor`, and the missing primitive `double amount` stays at `0.0`. Every settlement is booked at **£0.00**, with no exception and nothing in the dead-letter queue (DLQ).
- **The fix (branches `split/1-expand`, `split/2-migrate`, `split/3-contract`, `split/4-drop`):** each one deploys and rolls back to its predecessor with zero errors and correct amounts.

**Realism rules:**
- No faking. A rollback must actually run the previous git ref's code against the current DB and topic state. Build from git worktrees.
- Spring Kafka: **disable type headers** on the producer and use a fixed default type on the consumer, so v1 and v2 DTOs deserialize by field name only.
- Keep Jackson defaults, which ignore unknown properties. That default is what makes the silent £0.00 happen.
- Hibernate `ddl-auto=validate` on ledger-service, so v1 fails loudly against the V3 schema.
- `traffic.sh` must compress "25 minutes of settlements" into a few seconds of events.

## Environment

- Apple Silicon Mac (arm64). All Docker images must have arm64 builds.
- Java 21 + Spring Boot 3.x (Maven wrapper), Node 20+, Docker Desktop.
- Everything must start with one command: `demo/scripts/up.sh`.

## Working agreements

- Work phase by phase from the session plan. Start each phase in plan mode and get my OK before writing code.
- Commit at the end of every phase with a clear message. Append to `docs/progress.md`: what's done, decisions made and gotchas.
- When a phase has "Done when" criteria, actually run the checks and show me the output before calling it done.
- User-facing text (PR comments, README, docs) uses British English, short sentences and no hype.
- Never use real company names, real people or real payment data. Use invented names (e.g. "Northwind Payments").
