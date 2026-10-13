# Progress log

Newest phase at the bottom. Each entry: what's done, decisions, gotchas.

## Phase 0: Copilot formats (done)

- Wrote `docs/copilot-formats.md` from the live GitHub and VS Code docs (checked 7 Oct 2026).
- Decision: the in-repo `.github/skills/one-way-door/` is the source of truth. A generated Agent Plugins 1.0
  package under `plugins/one-way-door/` makes it installable in any repo ("pluggable").
- Decision: the preToolUse hook reads both payload shapes (camelCase `toolName/toolArgs` and VS Code's
  `tool_name/tool_input`) and prints both deny shapes (flat and `hookSpecificOutput`).
- Gotcha: on Copilot a preToolUse hook that exits non-zero **denies every tool call**. The hook must catch its own errors.
- Gotcha: the docs don't give the `edit`/`create` argument shapes or VS Code tool names. The hook matches on paths, not tool names.
- To confirm by hand later: path instructions in the CLI, VS Code honouring the deny, `${PLUGIN_ROOT}` in CLI plugin hooks.

## Phase 1: v1 demo on main (done)

- `demo/docker-compose.yml`: Postgres 16 (host port 55432), Kafka 4.1 in KRaft single-node mode, a `kafka-init` job that
  creates `payments.settled` and `payments.settled.DLT` (1 partition each), and Kafka UI under the `ui` profile. All arm64.
- settlement-service (Spring Boot 3.5.16, Java 21): `POST /settlements` publishes `PaymentSettled { double amount }`.
  The JsonSerializer has `setAddTypeInfo(false)`, so there are no type headers.
- ledger-service: ErrorHandlingDeserializer → JsonDeserializer with `use.type.headers=false` and a fixed default type.
  Flyway V1 (table) + V2 (index). `ddl-auto=validate`. DefaultErrorHandler → DeadLetterPublishingRecoverer (`.DLT`).
- reconciliation-batch: a plain `main()` doing `SELECT COUNT(*), SUM(amount)`. It prints a machine-readable `RECON` line.
- Scripts: `up.sh [--ui] [ref]`, `down.sh`, `traffic.sh N`, `ledger.sh`. Shared helpers live in `demo/scripts/lib.sh`.
- Decision: images are built **from git refs in a worktree** (`deploy_service` in lib.sh) and tagged by the service
  folder's tree hash. Each version builds once, and `owd/<service>:live` is what compose runs.
- Decision: `restart: on-failure`, like a Kubernetes pod. A service that fails on start-up keeps restarting.
- Decision: `traffic.sh` spaces `settledAt` 30s apart, ending now, so 50 events = "the last 25 minutes".
- Gotcha: macOS ships bash 3.2, and the scripts use `set -euo pipefail`. Avoid `cmd | grep -q`, because SIGPIPE plus
  pipefail gives false negatives. Avoid `(a && b) | c`. Use `grep -c` or plain `if` statements.
- Gotcha: the host has Java 25 and no Maven. All builds run inside `eclipse-temurin:21-jdk` with `./mvnw` and a
  BuildKit cache mount for `~/.m2`.
- Verified: `up.sh` → `traffic.sh 50` → `ledger.sh` gave 50 rows, £12903.26 sent = £12903.26 booked, 0 at £0.00, an
  empty DLT, both services UP, and a matching reconciliation total.

## Phase 2: the bad PR and a real incident (done)

- Branch `pr-482-minor-units`: V42 renames `amount` → `amount_minor` and retypes it to bigint `USING (amount_minor * 100)`.
  The event becomes `long amountMinor` (`amount` removed). Both services, their tests and the schema are updated.
  reconciliation-batch is **not** updated, which is deliberate: it is the blast radius the skill must find.
- Scripts: `deploy.sh <service> <ref>`, `rollback.sh` (same mechanics), `hotfix-reverse-v42.sql` + `apply-hotfix.sh`,
  `incident.sh [--no-pause]` (exits 0 only if the incident reproduces exactly), and `test.sh [ref]` (unit tests at any ref).
- The incident order is: v1 baseline (10) → deploy ledger then settlement at PR #482 → 20 settlements → reconciliation
  fails (`column "amount" does not exist`) → roll back ledger-service only → start-up fails with `Schema-validation:
  missing column [amount]` → 50 settlements queue → hotfix → v1 drains → 50 rows at £0.00, empty DLT, UP.
- Decision: the hotfix also deletes the V42 row from `flyway_schema_history`, so a later v2 redeploy would re-run it.
- Gotcha: Flyway v1 ignores the applied-but-unknown V42 (`ignoreMigrationPatterns` defaults to `*:future`). The loud
  failure comes from Hibernate `validate`, not from Flyway.
- Gotcha: with `restart: on-failure` the crash is detected through `RestartCount` or the "APPLICATION FAILED TO START" log line.
- Verified: `test.sh pr-482-minor-units` is green (settlement 4 tests, ledger 2). `incident.sh` passed 4 times out of 4
  from a clean `down.sh`, about 50s each.

## Phase 3: the skill (done)

- `.github/skills/one-way-door/SKILL.md`: 168 lines. Frontmatter has `name` (equals the folder), `description`
  (731 chars, names the triggers) and `license` only, which every surface supports. It sets an 8-step procedure.
- `references/patterns.md`: 24 patterns across Data, Messages, State and External, each with spot it, door closes,
  if rolled back, safe split and severity. It also has the general split table and the PR #482 worked example.
- `references/output-format.md`: the exact comment template and rules, plus ONE-WAY (PR #482) and TWO-WAY (split 2→3) examples.
- Decision: pattern ids are kebab-case (`column-rename`, `missing-primitive-default`, …). The scripts print the same ids.
- Decision: the split for PR #482 uses a trigger in step 3 to keep `amount` filled. That is the only way step 4
  (drop) can roll back to step 3 while step 3 can still roll back to step 2, whose reconciliation reads `amount`.

## Phase 4: deterministic scripts and tests (done)

- `scripts/scan-migrations.mjs`: Flyway (`V/R__`, plain `migrations/` SQL), Liquibase (XML, YAML, JSON, formatted SQL;
  changeSet-level edit detection) and EF Core (`Up()` only; Designer and snapshot files skipped). It flags
  `column-rename`, `table-rename`, `column-drop`, `table-drop`, `column-retype`, `not-null`, `in-place-conversion`,
  `backfill`, `row-delete` and `applied-migration-edited`. The SQL splitter honours quotes, dollar quotes, nested
  comments and `GO`, and scans inside `DO $$ … $$` blocks.
- `scripts/schema-compat.mjs`: JSON Schema diff in the old-reader direction, with `$ref`, nesting, arrays, enums,
  formats and nullability. It also flags `missing-primitive-default` in both directions (old readers without the
  field, and new readers on old events).
- `scripts/lib/common.mjs`: git helpers. **Merge-base (three-dot) semantics.** `--worktree` includes uncommitted and
  untracked files. Output is always JSON and the exit code is always 0.
- Tests: `node --test .github/skills/one-way-door/scripts/test/*.test.mjs`. That is 31 tests across 5 suites, each
  building throwaway git repos. All green.
- Verified against `main...pr-482-minor-units`. scan-migrations: column-rename (V42:3), column-retype and
  in-place-conversion (V42:4). schema-compat: event-field-removed `amount`, event-required-field-added
  `amountMinor`, event-field-renamed, and missing-primitive-default ×2. All high.
- Gotcha: on Node 22+, `node --test <dir>` no longer accepts a folder. Pass the files (a shell glob works on Node 20 too).

## Phase 5: the split and the proof (done)

- Branches from main: `split/1-expand` (V42 adds nullable `amount_minor`, the event gains optional `amountMinor`,
  writers write both, the reader prefers the new one), `split/2-migrate` (V43 backfill plus a DO-block check that
  fails if any row disagrees; reconciliation reports `mismatches=`), `split/3-contract` (V44: `amount_minor` NOT
  NULL, `amount` nullable and filled by a BEFORE INSERT trigger; ledger drops `amount` and rejects events without
  `amountMinor` to the DLT; reconciliation sums `amount_minor`), and `split/4-drop` (V45 drops the trigger, function
  and column; settlement and the schema are taken byte-for-byte from PR #482).
- `demo/scripts/rollback-test.sh <from> <to>` runs 5 stages covering every version combination (new consumer + old
  producer, both new, old consumer + new producer, both old). It checks after every stage: health, rows = sent,
  £0.00 rows, DLT, lag, reconciliation total = sent total, and column agreement.
- `demo/scripts/rollback-matrix.sh` runs all 5 cases and writes `docs/rollback-results.md`.
- Result: 4 PASS (main→1, 1→2, 2→3, 3→4) and 1 FAIL (main→PR #482), in about 4 minutes in total.
- Finding: PR #482 fails **before any rollback**. At stage 2 (new ledger, old settlement) it books £0.00 for every v1
  event, because the new consumer reads a missing `amountMinor` as 0. The door is one-way in both directions.
- Decision: the step-3 trigger is what makes step 4 roll back cleanly to step 3 while step 3 still rolls back to
  step 2, whose reconciliation reads `amount`.
- Gotcha: `exp` is a built-in function in awk and can't be a variable name.

## Phase 6: rule and hook (done)

- `.github/instructions/migrations.instructions.md`: `applyTo` covers `**/db/migration/**`, `**/db/changelog/**`,
  `**/migrations/**`, `**/Migrations/**`, `**/liquibase/**` and `contracts/events/**`. It sets the
  expand → migrate → contract → drop rules and says to run the one-way-door skill before finishing.
- `.github/hooks/one-way-door.json` (Copilot format, `version: 1`, `preToolUse`) calls
  `.github/hooks/scripts/deny-applied-migration-edit.sh` or `.ps1`. The hook denies edits, creates, patches and
  shell writes to Flyway `V__` files, SQL in `db/migration`/`migrations`, and EF Core migration classes **when the
  file exists on the default branch** (origin/HEAD, then main or master; override with `ONE_WAY_DOOR_BASE`). The
  denial suggests the next `V<n>__` name.
- Decision: Liquibase changelogs aren't blocked, because appending changeSets to an existing file is normal.
  scan-migrations checks changeSet edits instead. Repeatable `R__` and undo `U__` files are allowed.
- Decision: the hook matches on paths, not tool names. It reads both payload shapes (and `toolArgs` sent as a
  string), prints both deny shapes, and always exits 0. The JSON command falls back to `{}` if the script is missing.
- Tests: `node --test .github/hooks/scripts/test/*.test.mjs` runs 11 bash cases plus wiring, all green on macOS
  (bash 3.2). The PowerShell twin was verified in `mcr.microsoft.com/dotnet/sdk:9.0` (pwsh 7.5, bash 5): 26/26.
  `tests/instructions.test.mjs` checks `applyTo` against real paths: 4/4.
- Gotcha: `mcr.microsoft.com/powershell` has no arm64 images. The .NET SDK image has `pwsh` and git, and is arm64.

## Plugin packaging and CI (done)

- `plugins/one-way-door/` is an **Agent Plugins 1.0** package (`plugin.json` with the 1.0.0 `$schema`, `skills/`,
  and `com.github.copilot/hooks/hooks.json` with `${PLUGIN_ROOT}` paths). It is generated by
  `node tools/build-plugin.mjs`. `--check` fails if it drifts from `.github/skills` or `.github/hooks`.
- `.github/plugin/marketplace.json` makes the repo a one-plugin marketplace. Install with
  `copilot plugin install OWNER/REPO:plugins/one-way-door`, or with `copilot plugin marketplace add OWNER/REPO` then
  `copilot plugin install one-way-door@one-way-door`. In VS Code, use "Chat: Install Plugin From Source".
- The plugin's hook command fails open if `${PLUGIN_ROOT}` is neither expanded nor set. That is tested.
- `tests/skill.test.mjs` checks the frontmatter rules, that referenced files exist, that every pattern id the scripts
  emit has a catalogue entry, and that PR #482 stays out of SKILL.md. It caught demo-specific names in SKILL.md, now
  generic. `tests/plugin.test.mjs` checks the manifest schema, sync, the marketplace and the hook.
- `.github/workflows/ci.yml` runs all node tests (the runner has bash and pwsh) and each service's `./mvnw test`.
  `.github/workflows/copilot-setup-steps.yml` gives the cloud agent Node 20 and the default branch's history.
- All node tests: 61 (60 pass, plus 1 PowerShell test skipped locally; it passed in the container).

## Phase 7: Copilot test checklist (written; the manual runs are for you)

- `docs/copilot-test-checklist.md` covers VS Code agent mode, Copilot CLI (including the plugin install) and the
  cloud agent on a GitHub PR. For each: how to confirm the skill loaded (`/` menu or Chat: Open Customizations
  in VS Code, plus References under the answer; `/skills list`/`info`/`reload` in the CLI; the session log for the
  cloud agent), five fixed prompts (P1–P5), what a good result looks like, and a table of description tweaks if it
  doesn't trigger.
- Not done here: the hand-run in VS Code and Copilot CLI (no Copilot CLI on this machine). That is the next step for a person.

## Phase 8: stage-ready (done)

- `README.md`: the one-liner, the problem, "The £0.00 Settlement", how it works (skill, scripts, patterns, format,
  rule, hook, plugin), the rollback results table, how to use it in any repo (copy one folder, or install the
  plugin), the demo commands, tests, layout and limits.
- `docs/demo-script.md`: the 4-minute runbook in five acts (innocent PR, incident, run the skill, split, proof), with
  exact commands, the Copilot prompt, lines to say and a fallback for each act. Trick: send the Copilot prompt
  during act 1 so the answer is ready by act 3.
- `demo/scripts/reset.sh`: switches to main (if clean), pre-builds images for all six demo refs, restarts the
  stack at v1 and books 10 settlements. Measured: **15s**.
- After this phase, `pr-482-minor-units` and `split/*` were rebased onto the final main (`git rebase --update-refs`),
  so every branch carries the skill, rule and hook. Copilot needs them on the branch it reviews.

## Final verification (after the rebase)

- Node tests: 61 (60 pass, plus 1 PowerShell test skipped locally; it passed in the container). Unit tests green at
  `pr-482-minor-units` and `split/4-drop`.
- Scripts on `main...pr-482-minor-units`: scan-migrations finds 3 (rename V42:3, retype and in-place conversion V42:4).
  schema-compat finds 5 (amount removed, amountMinor required, rename, missing-primitive-default ×2). All high.
- `rollback-matrix.sh`: 4 PASS, 1 FAIL as expected, in 4m02s. `docs/rollback-results.md` is refreshed.
- `incident.sh --no-pause`: reproduced (50 rows at £0.00, £12,342.34 missing, empty DLT, ledger-service UP).
- `reset.sh`: 18s.

## Next

- Run `docs/copilot-test-checklist.md` by hand in VS Code and Copilot CLI. Tune the SKILL.md `description` if it
  doesn't trigger.
- Push to GitHub, open PR #482 from `pr-482-minor-units`, and try the cloud agent (checklist section C).
- Record a backup video of `docs/demo-script.md`.

## Laptop mode: the demo Control Centre (no Docker)

Why: the hackathon laptop is an org machine (Windows or macOS) with Java 21+, Node and Maven Central, but no Docker.

Done:
- `demo/control-centre/`: one Spring Boot process that replaces docker-compose and the bash scripts.
  - Real PostgreSQL 16 from Maven-packaged binaries (zonky embedded-postgres; macOS arm64/x64, Windows x64, Linux x64).
  - A real Kafka broker (KRaft) in the same JVM (spring-kafka-test, Kafka 3.9.2, the services' client line).
  - Builds each service from a git worktree with its own `mvnw`/`mvnw.cmd`; jars cached by tree hash, as the images were.
  - Runs the services as `java -jar` child processes. Rollbacks really run the previous commit.
  - Ports `incident.sh`, `rollback-test.sh` and `rollback-matrix.sh` one for one, with the same assertions.
    `hotfix` runs the existing `hotfix-reverse-v42.sql`.
- A React + Vite UI. Five tabs, one per act; a live system map, metrics, the ledger, a log, and a control room.
  - The map's dots are real records: a no-group observer consumer reads the payload (v1 `amount`, v2 `amountMinor`,
    or both).
  - Replay mode plays `recordings/incident.json`, a recorded real run, for when the venue laptop misbehaves.
  - The built bundle is committed to `src/main/resources/static`, so the laptop needs no npm. CI checks it is fresh.
- `demo/start.sh` and `demo/start.cmd`: build if needed, then run. Headless: `--owd.run=incident|matrix|prepare`.
- `.github/workflows/laptop-demo.yml`: headless incident and matrix on `windows-latest` and `macos-latest`, plus the
  bundle check. `control-centre` was added to the unit-test matrix in `ci.yml`.
- `docs/demo-script.md` rewritten around the console; the Docker route is kept at the end. README updated.

Decisions:
- Services and branches are untouched. The one launch-time difference: `/actuator/shutdown` is exposed so a
  rollback stops a service gracefully. Windows has no SIGTERM for a JVM, and a killed consumer would leave the next
  version waiting 45 s for the group session to time out.
- Postgres and Kafka start in a background thread. The UI and replay still work if a locked-down laptop blocks the
  Postgres binaries.
- `server.shutdown: immediate`: the browser's open event stream made graceful shutdown wait 30 s.

Gotchas:
- `EmbeddedKafkaKraftBroker.kafkaPorts()` is ignored in KRaft mode. A fixed `listeners` broker property
  (`EXTERNAL://localhost:9092,CONTROLLER://localhost:0`) pins the port.
- A Control Centre killed outright leaves its postgres running. On start it reads `postmaster.pid` and stops it.
  Leftover services are found through pid files.
- Spring Boot's `java.awt.headless` means `Desktop.browse` is out. The browser opens with `open` /
  `rundll32 url.dll,FileProtocolHandler`.
- Act 4 diff stats use three-dot diffs. main has moved on since the split branches were cut.

Verified on this Mac (Docker Desktop not running):
- Headless incident reproduced 4 times out of 4: JDK 21 (JBR 21.0.11) ×3 and JDK 25 ×1, in 17–36 s (the first run
  includes builds).
- Headless matrix: 4 PASS and 1 FAIL, as expected, in 1m52s (Docker: 4m02s). `docs/rollback-results.md` is refreshed.
- The full incident was clicked through in the UI, step by step, and Replay played the recording.
- Checked at 1280, 1440 and 1920 px with no console errors.
- Stop with Ctrl+C or SIGTERM: everything is gone in 2 s, with no java, postgres or ports left.
- `start.sh` built the Control Centre from a clean `target/` and prepared every ref.
- JUnit: 6 tests for the ported rules. Node tests: unchanged (60 pass, 1 PowerShell test skipped locally).

Not verified here: Windows. Its route uses `mvnw.cmd`, `cmd.exe` only for `.cmd` files, `ProcessHandle` and the
graceful-stop endpoints, with no bash anywhere. `laptop-demo.yml` on `windows-latest` is the check once the repo is
on GitHub.

## Migration numbering: V42 → V3 (and the split's V42–V45 → V3–V6)

Why: ledger-service on main has V1 and V2, so V42 implied 39 migrations that aren't in the repo. A judge would ask.
Flyway only orders by version, so behaviour is unchanged.

Done:
- main: the skill's worked examples and pattern catalogue, the plugin copy, the scan-migrations test, the instructions test,
  the hotfix (now `hotfix-reverse-v3.sql`, deleting history row `'3'`), the Docker scripts, the Control Centre and the
  docs. `CLAUDE.md`'s demo story now says V3. Earlier entries in this log keep the old numbers as history.
- Branches: rebuilt on the new main by cherry-picking each commit, renaming its migration file and fixing its message.
  `pr-482-minor-units` adds `V3__amount_minor_units.sql`. The split adds `V3__add_amount_minor`, `V4__backfill_amount_minor`,
  `V5__amount_minor_authoritative` and `V6__drop_amount`, as one stacked chain again.
- Not changed: the pitch deck (by request). The proposal PDF never named the migration, so it needed nothing.
- The explainer page artifact uses V3–V6 and the new recording's figures.

Verified:
- scan-migrations on `main...pr-482-minor-units`: the same 3 findings, at `V3__amount_minor_units.sql:3` and `:4`;
  schema-compat: the same 5.
- Unit tests green on all five branches (settlement 3–4, ledger 2–3; reconciliation-batch has none).
- Node tests: 60 pass, 1 skipped (PowerShell). Headless incident reproduced and was re-recorded (Flyway: "3 - amount
  minor units", 0.005 s; sent £22,405.89, booked £9,026.02, missing £13,379.87). Rollback matrix: 4 PASS, 1 FAIL,
  as expected.
