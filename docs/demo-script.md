# Demo script: four minutes, five acts

The story: a sensible PR with green tests, a real incident, the skill that would have caught it, the safe version,
and the proof.

Everything on screen is real. The rollback really rebuilds the old code from git and runs it against the new
database and topic.

The whole talk runs from the **demo Control Centre**, a browser console at http://localhost:7070. It needs only Java
21+ and git on the laptop: no Docker. Its tabs are the five acts. Its live map shows the system the whole time: the
services and their versions, the Kafka topic with every real event on it, and the ledger table. The Docker scripts
still work; see [With Docker](#with-docker) at the end.

## The day before (on the presenting laptop)

```bash
demo/start.sh          # macOS
demo\start.cmd         # Windows
```

- [ ] **System check** (top right): Java, git, demo branches and Postgres + Kafka are green.
- [ ] **Prepare**: builds all six refs once (2–5 minutes the first time), then starts v1 with 10 settlements.
- [ ] Control room → **Record the incident**: saves a real run for Replay mode, the act 2 fallback (about 40 s).
- [ ] Act 5 → **Run all**: refreshes the matrix and `docs/rollback-results.md` (about 2 minutes).

## Before you go on (5 minutes before)

- [ ] Control Centre running, **Prepare** pressed (about 15 s once built). Act 1 open. Browser full screen, zoom
      so the map and the narrator card both fit (about 110% on a 1080p projector).
- [ ] **VS Code** on the repo, Chat in **Agent** mode, a fresh chat ready. Font zoomed.
- [ ] Optional: the GitHub PR for `pr-482-minor-units` open in a browser, with green CI.
- [ ] The backup video is ready to play.
- [ ] Notifications off.

Keys: `1`–`5` switch acts. In act 2, `→`, Space or a presentation clicker runs the next step.

---

## Act 1: The innocent PR (0:00–0:35)

**Show** tab **1 The PR**: the PR title, the V3 migration (the rename and the in-place `USING` conversion are
highlighted) and the event contract diff. Press **Run tests** just before you start talking: three real Maven test
runs at the PR's commit come back green while you speak.

**Say:**
> "Northwind Payments stores money as a `double`. That's a bug waiting to happen, so PR #482 moves to pence. It
> renames the column, converts the values, and updates both services. Tests are green. You'd approve this. I would."

**Do now:** in VS Code, paste prompt **P1** (act 3) and send it, so the answer is ready when you get there.

---

## Act 2: The incident (0:35–1:45)

**Click** tab **2 The incident**. The controls sit right under the map: the seven steps, **Start**, and the live numbers
(sent, booked, missing, £0.00 rows, backlog, dead letters). Press **Start**, then `→` for each step. Each takes 2–10
seconds of real work. Point at the map while it runs: orange dots are v2 events, the backlog fills the pipe, and the
ledger turns red. After step 7 the red verdict replaces the caption, in the same place.

| Step | The map shows | Say |
|---|---|---|
| 1 · 16:30 | Both services on `v1 · main`, green dots | "Friday afternoon. Ten settlements, all in pounds." |
| 2 · 16:40 | Both on `v2 · PR #482`; `amount` renamed in the table; orange dots | "PR #482 ships. Flyway renames the column on start-up." |
| 3 · 16:55 | reconciliation-batch red: `column "amount" does not exist` | "Finance's reconciliation job breaks. Nobody touched it, but it reads that column." |
| 4 · 16:58 | ledger-service red: `Schema-validation: missing column [amount]` | "So on-call presses rollback. The old code won't even start: the column it needs is gone." |
| 5 · 17:00 | 50 orange events queue in the pipe; backlog 50 | "Meanwhile settlements keep arriving. They queue on Kafka, in the new format." |
| 6 · 17:25 | ledger back to green v1; dots drain and pop **£0.00** | "A DBA reverses V3 by hand. v1 comes back up and drains the queue." |
| 7 · 17:26 | Red banner: about **£12,000 is missing**, 50 at £0.00, DLT 0 | "Every dashboard is green. And fifty settlements are booked at **£0.00**. No exception. Nothing in the dead-letter queue." |

**Close the act:**
> "The rollback didn't roll back the database, or the events already on the topic. That PR was a one-way door,
> and nothing in our pipeline asks that question."

**Fallback:** if anything misbehaves, switch the top-right toggle to **Replay**. It plays the run recorded the day
before, with the same steps, timing and map, and says it is a recording. Last resort: the backup video from 0:35.

---

## Act 3: Rewind, and run the skill (1:45–2:45)

**Show** VS Code: the answer to prompt **P1** (sent in act 1).

```text
Review the pr-482-minor-units branch against main. If this goes wrong after deploy, can we roll back?
```

**Point at, in this order:**
1. The verdict line: `Verdict: ONE-WAY · Safe rollback window: none`.
2. Finding 1: the rename and in-place conversion, and that "the door closes when ledger-service starts".
3. Finding 3: "books the settlement at **£0.00, silently**". It predicted the incident we just watched.
4. Blast radius: **reconciliation-batch, not in this PR**.
5. Expand **References**: `one-way-door` SKILL.md, `patterns.md` and `output-format.md` were used.

Then tab **3 The review** in the console. The **It predicted act 2** card puts each finding next to the real error
from act 2.

**Say:**
> "It's a Copilot skill: one folder in `.github/skills`. Two small offline scripts do the mechanical checks on the
> migrations and the event schema. Copilot does the judgment: who else reads this column, and what does the old
> code do with the new state."

**Fallback:** if Copilot is slow or offline, tab 3 shows the skill's worked example (the same review). **Script
findings** shows the scripts' output, run live when Node is installed.

---

## Act 4: The split (2:45–3:20)

**Say:** "I asked it to generate the split." (Typing "Generate the split." works, but it takes minutes. These
branches are what it produced.)

**Show** tab **4 The split**: four cards, expand → migrate → contract → drop, each with its branch, commit and
why it rolls back. The green box confirms the same end state as PR #482.

**Say:**
> "Same destination as PR #482, in four steps: expand, migrate, contract, drop. Every commit says why it rolls back
> to the one before."

---

## Act 5: The proof (3:20–4:00)

**Show** tab **5 The proof**. Under the map is the rollback-test panel: five stage cards showing which version of each
service runs, whether the database already has the new migration, what the stage is doing right now (deploying,
sending 20 settlements, waiting for the ledger, running reconciliation), and, once done, the six checks with their real
numbers. The full matrix is below it; click a row to show it in the panel.

**Say:**
> "Each row deploys for real, sends traffic, rolls back, and sends traffic again, through every mix of old and new
> versions. Four passes, one fail. And PR #482 fails *before* anyone presses rollback: a new consumer reading old
> events also books zero."
>
> "One-Way Door: it tells you before you merge whether you'll be able to roll back. Copy one folder into your
> repo, or install it as a Copilot plugin."

**If you have 30 spare seconds:** pick `split 2 → split 3` in the panel and press **Run this row**. Talk over the stage
cards as they fill in: "new ledger, old events… both new… now the old ledger on the new database". For the failure,
run `main → PR #482`: stage 2 goes red with 20 rows at £0.00 while the map shows it happening.

**Fallback:** the matrix is a file (`demo/control-centre/recordings/matrix.json`). It shows without running anything.

---

## After the demo

Press **Prepare** for the next run, or stop the Control Centre with Ctrl+C. That stops the services, Kafka and
Postgres.

---

## With Docker

The original scripts still work on a machine with Docker Desktop:

```bash
demo/scripts/reset.sh                 # about 15s once images exist; builds them the first time
demo/scripts/incident.sh              # act 2, Enter at each pause
demo/scripts/rollback-matrix.sh       # act 5 table, about 4 min
demo/scripts/rollback-test.sh split/2-migrate split/3-contract
```

For acts 1 and 4 without the console, use plain git:

```bash
git diff --stat main...pr-482-minor-units
git show pr-482-minor-units:demo/ledger-service/src/main/resources/db/migration/V3__amount_minor_units.sql
git log --oneline main..split/4-drop
git diff --stat pr-482-minor-units split/4-drop -- contracts demo/settlement-service   # empty: same end state
```
