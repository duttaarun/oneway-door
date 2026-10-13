# Running the demo

This is how to set up and run the One-Way Door demo on a laptop: the £0.00 incident, the review, the split and the
rollback proof. It works on **Windows and macOS** (and Linux) with only **Java 21+ and git**. There's no Docker, and
no database or Kafka to install.

- **The talk itself** (what to click and what to say): [docs/demo-script.md](docs/demo-script.md)
- **Setting up the Copilot skill** (act 3): [docs/setup.md](docs/setup.md)
- **Inside the Control Centre:** [demo/control-centre/README.md](demo/control-centre/README.md)

---

## 1. What runs

Everything runs on your laptop, started by one command:

```
Browser  http://localhost:7070  (React UI: live map, the five acts, the control room)
   │
Control Centre  (one Java process, Spring Boot)                       :7070
   ├─ PostgreSQL 16, real binaries, started by the Control Centre       :55432
   ├─ Kafka broker (KRaft), inside the Control Centre's JVM             :9092
   ├─ builds each service from a git branch, using its Maven wrapper
   └─ runs the services as java child processes:
        ├─ settlement-service   Spring Boot, POST /settlements → Kafka   :8081
        ├─ ledger-service       Spring Boot, Kafka → Postgres            :8082
        └─ reconciliation-batch plain Java, reads Postgres on demand
```

| Component | What it is | Code |
|---|---|---|
| **settlement-service** | Takes a settlement over HTTP and publishes a `PaymentSettled` event to `payments.settled` | `demo/settlement-service` |
| **ledger-service** | Consumes the events and books them into `ledger_entries`. Runs Flyway migrations on start-up. | `demo/ledger-service` |
| **reconciliation-batch** | Finance's job: sums `ledger_entries` directly | `demo/reconciliation-batch` |
| **Control Centre** | Starts Postgres and Kafka, builds and runs the three services, and serves the UI | `demo/control-centre` |

Northwind Payments is invented. All names and amounts are demo data.

---

## 2. What you need

| Need | Version | Why | Check with |
|---|---|---|---|
| **Java (JDK)** | **21 or later** | Builds and runs everything. Tested on 21 and 25. | `java -version` |
| **git** | Any 2.x | The demo builds each service from a git branch | `git --version` |
| **A web browser** | Any current one | The UI | |
| **Internet, the first time only** | Maven Central, or your company's mirror | Downloads Maven and the libraries once (section 5) | |
| **Disk space** | About 2.5 GB free | Libraries (~400 MB), the Control Centre (~300 MB), built services and data (~1.3 GB) | |
| **Free ports** | 7070, 8081, 8082, 9092, 55432 | See section 1 | |
| **Node.js** (optional) | 20 or later | Only for the Copilot skill's scripts in act 3, and for changing the UI | `node -v` |

**You don't need:** Maven, Docker, PostgreSQL, Kafka, npm packages, or admin rights.

---

## 3. Get the code

The demo needs the repository **with its git history**, plus six **local** branches: `main`, `pr-482-minor-units`
and `split/1-expand` to `split/4-drop`. Get the code either way:

- **A zip**, such as GitHub's "Download ZIP" or a copy of the folder. A zip has no `.git` folder, so no branches.
  Unzip it anywhere.
- **A clone:** `git clone <repo-url> oneway-door`. A clone only creates `main` locally.

Then run the restore script once, from anywhere:

```bash
sh demo/restore-branches.sh       # macOS or Linux ("sh" works even if the zip lost the executable bit)
```

```bat
demo\restore-branches.cmd         :: Windows
```

It needs only git. It creates the repository if there isn't one and keeps the files as they are. It then recreates
each missing branch, with its history: from `origin` after a clone, or from `demo/branches.bundle` after a zip. It
never moves a branch that already exists, so running it again is safe. It ends with a list of the branches.

Keep `demo/branches.bundle` in the zip; the restore can't work without it. After changing a demo branch, rebuild it
with `demo/make-branch-bundle.sh` and commit it.

Stay on `main`. The Control Centre builds the other branches itself, in separate git worktrees, so your checkout is
never switched.

---

## 4. Install Java (if it isn't there)

Any JDK 21+ works: Eclipse Temurin, Microsoft Build of OpenJDK, Oracle, Zulu, Amazon Corretto.

| OS | Command |
|---|---|
| Windows | `winget install EclipseAdoptium.Temurin.21.JDK` |
| macOS | `brew install --cask temurin@21` |
| Linux (Debian/Ubuntu) | `sudo apt install openjdk-21-jdk` |

Then open a new terminal and check `java -version`.

- **Which Java gets used:** the start scripts use `JAVA_HOME` if it's set, otherwise `java` on your PATH.
- **The services use the same JDK:** everything the Control Centre builds and runs uses the JDK the Control Centre
  itself runs on.

---

## 5. Maven: nothing to install

Every Java project here has a **Maven wrapper** (`mvnw` for macOS and Linux, `mvnw.cmd` for Windows). It downloads
the right Maven (3.9.11) on first use, so you never install Maven yourself.

### What gets downloaded, and where

| What | From | To | When |
|---|---|---|---|
| Maven 3.9.11 (~10 MB) | Maven Central | `~/.m2/wrapper/` | The first build |
| Spring Boot, Kafka, Flyway, Hibernate and other libraries (~400 MB) | Maven Central | `~/.m2/repository/` | The first build of each project |
| PostgreSQL 16 binaries for macOS, Windows and Linux (inside the Control Centre's libraries) | Maven Central | `~/.m2/repository/`, then unpacked to `.demo/cc/pg-bin/` | First Control Centre build, then first start |

On Windows, `~` is `C:\Users\<you>`. After the first run, nothing more is downloaded: the demo works offline.

### Download everything in advance

Do this the day before, on a good network:

```bash
demo/start.sh --owd.run=prepare        # macOS / Linux
```

```bat
demo\start.cmd --owd.run=prepare
```

It builds the Control Centre and **every service on every demo branch** (about 2–5 minutes the first time). Then it
starts v1 with 10 settlements, to prove it works, and exits, stopping everything again. Pressing **Prepare** in the UI
does the same, but leaves v1 running.

### Behind a company proxy or mirror

**Libraries from a company mirror** (Artifactory, Nexus): add the mirror to `~/.m2/settings.xml`.

```xml
<settings>
  <mirrors>
    <mirror>
      <id>company</id>
      <mirrorOf>*</mirrorOf>
      <url>https://artifactory.example.com/artifactory/maven-remote/</url>
    </mirror>
  </mirrors>
</settings>
```

**Maven itself from the mirror:** set `MVNW_REPOURL` to the mirror's base URL. Add `MVNW_USERNAME` and
`MVNW_PASSWORD` if it needs a login.

**A proxy:** add a `<proxies>` section to `settings.xml` for the libraries, and set `HTTPS_PROXY` in your environment
for the wrapper's own download.

**A Maven you already have:** set `OWD_MVN=mvn` before starting. The Control Centre then uses it instead of the
wrappers.

### Building a project by hand

You don't need to; the Control Centre does it. But it's useful when checking that the network works:

```bash
cd demo/ledger-service
./mvnw -B package -DskipTests          # Windows: mvnw.cmd -B package -DskipTests
./mvnw -B test                         # the unit tests
```

The result is `target/app.jar`.

---

## 6. Node libraries

| Part | npm libraries? | What to do |
|---|---|---|
| **The Copilot skill's scripts** (`scan-migrations.mjs`, `schema-compat.mjs`) | **None.** Node's standard library only. | Install Node 20+. Nothing else. |
| **The demo UI** (React + Vite) | Yes, but **only to change the UI** | Nothing to run the demo: the built UI is committed inside the Control Centre. |
| **Copilot CLI** (optional, act 3) | Installs as a global npm package | See [docs/setup.md](docs/setup.md#5-copilot-cli). Needs Node 22+. |

### Changing the UI

```bash
cd demo/control-centre/ui
npm ci              # installs the exact versions in package-lock.json: React 18.3, Vite 5.4, TypeScript 5.6, marked 14
npm run dev         # http://localhost:5173, live reload, talks to a running Control Centre on :7070
npm run build       # writes ../src/main/resources/static; commit it so the demo laptop needs no npm
```

For a company npm registry, run `npm config set registry https://artifactory.example.com/api/npm/npm-remote/`
first. After `npm run build`, restart the Control Centre so it serves the new UI:
- **macOS and Linux:** `start.sh` notices the change and rebuilds.
- **Windows:** `start.cmd` only builds when the jar is missing, so delete `demo\control-centre\target` first.

---

## 7. Start the demo

macOS or Linux:

```bash
demo/start.sh
```

Windows (Command Prompt or PowerShell):

```bat
demo\start.cmd
```

### What happens

1. **First time only:** the script builds the Control Centre with its Maven wrapper. A few minutes.
2. **The Control Centre starts** in about 2 seconds and opens **http://localhost:7070** in your browser.
3. **Postgres and Kafka start in the background.** "Postgres + Kafka up" appears at the top of the page, after about
   1 second. The very first time, unpacking Postgres takes about 7 seconds.
4. **Nothing else is running yet.** The map shows every service as "not deployed".

### Then, in the browser

1. **System check** (top right): Java, git, the six branches, Postgres + Kafka and Maven Central should be green.
   Node only matters for act 3.
2. **Prepare:** builds every branch (cached after the first time), starts all three services at `main` (v1) and sends
   10 settlements. About 15 seconds once built.
3. **The map shows the system live:** both services on **v1 · main** and UP, 10 events on the topic, 10 rows in
   `ledger_entries`.

You're ready. The acts are the tabs: **1 The PR, 2 The incident, 3 The review, 4 The split, 5 The proof**. Keys `1`–`5`
switch tabs. In act 2, `→`, Space or a presentation clicker runs the next step.

### Stop it

Press **Ctrl+C** in the terminal. That stops the services, Kafka and Postgres too, in about 2 seconds. If the
Control Centre was killed instead, the next start finds and stops anything left over.

### Options

| Setting | Default | Example |
|---|---|---|
| UI port | 7070 | `OWD_PORT=7171 demo/start.sh` |
| Postgres port | 55432 | `OWD_PG_PORT=55433` |
| Kafka port | 9092 | `OWD_KAFKA_PORT=19092` |
| Don't open a browser | opens one | `demo/start.sh --owd.open-browser=false` |
| Repository location | found from the current folder | `--owd.root=/path/to/oneway-door` |

The services' own ports, 8081 and 8082, are fixed.

### Without the browser

Each of these runs a whole scenario, prints what happens, and exits 0 if the result is as expected:

```bash
demo/start.sh --owd.run=incident                      # the £0.00 incident: 50 rows at £0.00, empty DLT
demo/start.sh --owd.run=matrix                        # rollback matrix: 4 PASS, 1 FAIL; writes docs/rollback-results.md
demo/start.sh --owd.run=prepare                       # build everything, start v1 with 10 settlements
demo/start.sh --owd.run=incident --owd.record=true    # also save the run for Replay mode
```

On Windows, use `demo\start.cmd` with the same options.

---

## 8. Start a service by hand (optional)

The Control Centre normally starts the services. To run one yourself, for example to debug it:

1. **Clear its port.** In the UI, open **Control room → Stop all and wipe**. This stops the services but keeps
   Postgres and Kafka running.
2. **Build and run it**, pointing it at the Control Centre's Postgres and Kafka. macOS or Linux:

   ```bash
   cd demo/ledger-service
   ./mvnw -B -q package -DskipTests
   DB_URL=jdbc:postgresql://localhost:55432/ledger KAFKA_BOOTSTRAP=localhost:9092 java -jar target/app.jar
   ```

   Windows PowerShell:

   ```powershell
   cd demo\ledger-service
   .\mvnw.cmd -B -q package -DskipTests
   $env:DB_URL = 'jdbc:postgresql://localhost:55432/ledger'; $env:KAFKA_BOOTSTRAP = 'localhost:9092'
   java -jar target\app.jar
   ```

   settlement-service only needs `KAFKA_BOOTSTRAP`. reconciliation-batch only needs `DB_URL`; it prints a
   `RECON …` line and exits.
3. **Check it:** open `http://localhost:8082/actuator/health` (8081 for settlement-service). It should say
   `"status":"UP"`.
4. **Send a settlement:**

   ```bash
   curl -i -H 'Content-Type: application/json' \
     -d '{"merchantId":"merchant-0001","currency":"GBP","amount":12.34,"settledAt":"2026-10-13T16:30:00Z"}' \
     http://localhost:8081/settlements
   ```

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://localhost:8081/settlements -ContentType 'application/json' `
     -Body '{"merchantId":"merchant-0001","currency":"GBP","amount":12.34,"settledAt":"2026-10-13T16:30:00Z"}'
   ```

   `202 Accepted` means the event is on Kafka. The UI's map and ledger table show it arrive.

To build a different version, check out that branch in its own folder (`git worktree add ../v2 pr-482-minor-units`)
and build there.

---

## 9. The day before the talk

On the laptop you'll present from:

- [ ] `demo/start.sh` (or `demo\start.cmd`) starts, and **System check** is all green.
- [ ] **Prepare** completes. This also proves every branch builds.
- [ ] Run act 2 once, end to end, with **Start** and `→`.
- [ ] **Control room → Record the incident.** This saves a real run for **Replay**, the fallback if anything misbehaves
      on the day.
- [ ] Act 5: **Run all 5 rows** (about 2 minutes). Expect 4 PASS and 1 FAIL.
- [ ] Act 3: Copilot in VS Code answers the review prompt and lists `one-way-door` under References
      ([docs/setup.md](docs/setup.md)).
- [ ] Ctrl+C, start again, **Prepare**. That's the state to walk on stage with.

The four-minute script is [docs/demo-script.md](docs/demo-script.md).

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `java` not found, or "unsupported class file version" | Install JDK 21+ (section 4). Check `java -version` and `JAVA_HOME`. |
| First build fails while downloading | Check the network to Maven Central, or set up your mirror or proxy (section 5). Logs are in `.demo/cc/logs/build-*.log`. |
| System check: branches missing | Run `sh demo/restore-branches.sh` or `demo\restore-branches.cmd` (section 3). |
| Restore says `branches.bundle` is missing | The zip left out `demo/branches.bundle`. Copy it from the original project. |
| "Port … already in use" | Close whatever uses it, or move the Control Centre's ports with `OWD_PORT`, `OWD_PG_PORT` or `OWD_KAFKA_PORT`. 8081 and 8082 must be free. |
| Map says "Postgres or Kafka did not start" | Start again with `--logging.level.io.zonky=INFO` added to see Postgres's own messages. The laptop may block the Postgres binaries unpacked under `.demo/cc/pg-bin/`: ask IT, or present with **Replay**, which needs nothing else. |
| A service shows "failed to start" outside the incident | Open `.demo/cc/logs/<service>.log`. |
| `£` shows as `Â£` in a Windows terminal | Only affects headless output. `start.cmd` already switches the console to UTF-8. The browser is unaffected. |
| The UI looks out of date after a change | Rebuild with `npm run build`, then restart the Control Centre. On Windows, delete `demo\control-centre\target` first. |
| Start from scratch | Stop the Control Centre and delete `.demo/cc/`. The next start rebuilds what it needs. |

---

## 11. With Docker instead

If the laptop does have Docker Desktop, the original scripts still work. They need Docker, Node 20+ and git; Java and
Maven run inside containers.

```bash
demo/scripts/reset.sh                 # build images, start Postgres + Kafka + v1, book 10 settlements
demo/scripts/incident.sh              # act 2, Enter at each pause
demo/scripts/rollback-matrix.sh       # act 5 table
demo/scripts/down.sh                  # stop and remove everything
```

These are bash scripts, so they run on macOS and Linux only, not plain Windows.

---

## 12. Files the demo creates

Everything lives in `.demo/cc/` inside the repository, which git ignores:

| Folder | What |
|---|---|
| `jars/` | Built services, one per service per git tree, reused across runs |
| `logs/` | Each service's log, and Maven build logs |
| `pgdata/`, `pg-bin/` | The Postgres data (wiped on each start) and its unpacked binaries |
| `wt/` | Temporary git worktrees used for builds |
| `run/` | Process ids, so leftovers can be cleaned up |

Outside the repository, there's only Maven's cache in `~/.m2/`.
