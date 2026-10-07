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
