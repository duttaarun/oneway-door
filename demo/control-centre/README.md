# Demo Control Centre

The One-Way Door demo, on a plain laptop. It needs **Java 21+ and git**: no Docker, no database or Kafka install, no
Maven, no npm. It works on Windows and macOS.

```bash
demo/start.sh          # macOS / Linux
```

```bat
demo\start.cmd
```

The first start builds the Control Centre with its Maven wrapper (a few minutes while dependencies download). After
that it starts in about 2 seconds and opens **http://localhost:7070**.

## What it is

One Java process (Spring Boot) that replaces `docker-compose.yml` and the bash scripts, plus a React UI:

```
Browser (React + Vite, served from this jar)
   │  REST + Server-Sent Events
Control Centre :7070
   ├─ PostgreSQL 16, real binaries from Maven (zonky embedded-postgres)    :55432
   ├─ Kafka broker, KRaft, in this JVM (spring-kafka-test)                 :9092
   ├─ observer: reads every record on payments.settled, so the UI can colour v1 / v2 payloads
   ├─ builder: git worktree at the ref → the service's own mvnw → jar cached by git tree hash
   └─ runner: java -jar child processes, graceful stop, health, start-up failure root cause
          ├─ settlement-service :8081
          ├─ ledger-service     :8082
          └─ reconciliation-batch (on demand)
```

The services and branches are unchanged. A rollback is real: the previous commit is built from git and run against
today's database and topic. The only launch-time difference from Docker is that each service exposes
`/actuator/shutdown`. That lets a rollback stop it gracefully, so its Kafka consumer leaves the group at once. Windows
has no SIGTERM for a JVM.

| Old script | Here |
|---|---|
| `up.sh`, `down.sh`, `reset.sh` | **Prepare** button; Control room → Fresh start, Stop all |
| `deploy.sh`, `rollback.sh` | Control room → Build and deploy |
| `traffic.sh`, `ledger.sh` | Act 2 buttons, the metrics rail and the ledger table |
| `apply-hotfix.sh` | Control room → Apply V42 hotfix (runs `demo/scripts/hotfix-reverse-v42.sql`) |
| `incident.sh` | Act 2, one step per click (or `→`), or `--owd.run=incident` |
| `rollback-test.sh`, `rollback-matrix.sh` | Act 5, or `--owd.run=matrix` (writes `docs/rollback-results.md`) |
| `test.sh` | Act 1 → Run tests |

## Before the talk

1. On the presenting laptop, run `demo/start.sh` (or `demo\start.cmd`) and open **System check**. Java, git, the
   demo branches and Postgres + Kafka should all be green.
2. Press **Prepare**. It builds all six refs once (about 2–5 minutes the first time), then starts v1 with 10
   settlements.
3. Control room → **Record the incident**. This saves a real run to `recordings/incident.json` for **Replay** mode.
4. Optionally, act 5 → **Run all** to refresh the matrix (about 2 minutes).

Keyboard: `1`–`5` switch acts. In act 2, `→`, Space or a presentation clicker runs the next step.

## Headless

```bash
demo/start.sh --owd.run=incident        # exit 0 = reproduced: 50 rows at £0.00, empty DLT, ledger UP
demo/start.sh --owd.run=matrix          # exit 0 = four PASS and one FAIL
demo/start.sh --owd.run=prepare
demo/start.sh --owd.run=incident --owd.record=true   # also writes recordings/incident.json
```

## If something goes wrong on the day

| Symptom | What to do |
|---|---|
| Port 7070, 8081, 8082, 9092 or 55432 in use | Close whatever holds it, or set `OWD_PORT`, `OWD_KAFKA_PORT` or `OWD_PG_PORT`. The services' ports are fixed. |
| "Postgres or Kafka did not start" on the map | The laptop may block running the Postgres binaries. Switch to **Replay**: it needs nothing but this jar. |
| First build fails to download | Maven Central (or your company mirror in `~/.m2/settings.xml`) must be reachable once. Or set `OWD_MVN=mvn` to use a Maven you have. |
| `£` shows as `Â£` in a Windows console | Only affects headless output; `start.cmd` already switches the console to UTF-8. The browser UI is unaffected. |
| A run was killed half-way | Start again. Leftover services and a leftover Postgres are found by pid and stopped. |

State lives in `.demo/cc/` (jars, logs, Postgres data, worktrees), which git ignores. Delete it to start from scratch.

## Developing the UI

```bash
cd demo/control-centre/ui
npm install
npm run dev            # http://localhost:5173, proxies /api to a running Control Centre on :7070
npm run build          # writes ../src/main/resources/static (commit it: the laptop needs no npm)
```

CI checks that the committed bundle matches the source.

## Tests

```bash
cd demo/control-centre && ./mvnw -B test                       # the rules ported from the bash scripts
```

The full check is the headless incident and matrix, which `.github/workflows/laptop-demo.yml` runs on Windows and
macOS.

Fonts: Source Serif 4, Source Sans 3 and JetBrains Mono (SIL Open Font Licence), the same open stand-ins as the
proposal PDF, served locally so the UI needs no network.
