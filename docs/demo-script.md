# Demo script: four minutes, five acts

The story: a sensible PR with green tests, a real incident, the skill that would have caught it, the safe version,
and the proof.

Everything on screen is real. The rollback really rebuilds the old code from git and runs it against the new
database and topic.

## Before you go on (10 minutes before)

```bash
demo/scripts/reset.sh                 # about 15s once images exist; builds them the first time
demo/scripts/rollback-matrix.sh       # about 4 min; refreshes docs/rollback-results.md for act 5
PAUSE=0 demo/scripts/incident.sh > .demo/logs/incident-rehearsal.log 2>&1   # a rehearsal log, kept for the act 2 fallback
demo/scripts/reset.sh                 # back to the start: v1 running, 10 settlements booked
```

- [ ] **Terminal 1** (big font, about 20pt) at the repo root, on `main`.
- [ ] **Terminal 2** with `docs/rollback-results.md` open (`cat` it, or open it in VS Code preview).
- [ ] **VS Code** on the repo, Chat in **Agent** mode, a fresh chat ready. Font zoomed.
- [ ] Optional: the GitHub PR for `pr-482-minor-units` open in a browser, with green CI.
- [ ] The backup video is ready to play.
- [ ] Notifications off.

---

## Act 1: The innocent PR (0:00–0:35)

**Show** (terminal 1):

```bash
git diff --stat main...pr-482-minor-units
git show pr-482-minor-units:demo/ledger-service/src/main/resources/db/migration/V42__amount_minor_units.sql
```

Then the green CI on the GitHub PR. Or, already run in terminal 2: `demo/scripts/test.sh pr-482-minor-units`.

**Say:**
> "Northwind Payments stores money as a `double`. That's a bug waiting to happen, so PR #482 moves to pence. It
> renames the column, converts the values, and updates both services. Tests are green. You'd approve this. I would."

**Fallback:** if the browser or network is down, use `git log -1 pr-482-minor-units` (the PR description is the commit message).

**Do now:** in VS Code, paste prompt **P1** (act 3) and send it, so the answer is ready when you get there.

---

## Act 2: The incident (0:35–1:45)

**Run** (terminal 1, press Enter at each pause):

```bash
demo/scripts/incident.sh
```

**Say, one line per caption:**

| Caption | Say |
|---|---|
| 0 · v1 | "Friday afternoon. Ten settlements, all in pounds." |
| 1 · deploy | "PR #482 ships. Flyway renames the column on start-up." |
| 2 · reconciliation fails | "Finance's reconciliation job breaks. Nobody touched it, but it reads that column." |
| 3 · roll back | "So on-call presses rollback. The old code won't even start: the column it needs is gone." |
| 4 · backlog | "Meanwhile settlements keep arriving. They queue on Kafka, in the new format." |
| 5 · hotfix | "A DBA reverses V42 by hand. v1 comes back up and drains the queue." |
| 6 · £0.00 | "Every dashboard is green. And fifty settlements, about £12,000, are booked at **£0.00**. No exception. Nothing in the dead-letter queue." |

**Close the act:**
> "The rollback didn't roll back the database, or the events already on the topic. That PR was a one-way door,
> and nothing in our pipeline asks that question."

**Fallback:** if Docker misbehaves, play the backup video from 0:35, or `less -R .demo/logs/incident-rehearsal.log`.

---

## Act 3: Rewind, and run the skill (1:45–2:45)

**Prompt P1** (already sent in act 1; show the answer now):

```text
Review the pr-482-minor-units branch against main. If this goes wrong after deploy, can we roll back?
```

**Point at, in this order:**
1. The verdict line: `Verdict: ONE-WAY · Safe rollback window: none`.
2. Finding 1: the rename and in-place conversion, and that "the door closes when ledger-service starts".
3. Finding 3: "books the settlement at **£0.00, silently**". It predicted the incident we just watched.
4. Blast radius: **reconciliation-batch, not in this PR**.
5. Expand **References**: `one-way-door` SKILL.md, `patterns.md` and `output-format.md` were used.

**Say:**
> "It's a Copilot skill: one folder in `.github/skills`. Two small offline scripts do the mechanical checks on the
> migrations and the event schema. Copilot does the judgment: who else reads this column, and what does the old
> code do with the new state."

**Fallback:** if Copilot is slow or offline, show the worked example in
`.github/skills/one-way-door/references/output-format.md`, which is the same review. Or run the scripts live:

```bash
node .github/skills/one-way-door/scripts/scan-migrations.mjs --base main --head pr-482-minor-units | head -40
```

---

## Act 4: The split (2:45–3:20)

**Say:** "I asked it to generate the split." (Typing "Generate the split." works, but it takes minutes. These
branches are what it produced.)

**Show:**

```bash
git log --oneline main..split/4-drop
git log -1 --format=%B split/3-contract | tail -4
git diff --stat pr-482-minor-units split/4-drop -- contracts demo/settlement-service   # empty: same end state
```

**Say:**
> "Same destination as PR #482, in four steps: expand, migrate, contract, drop. Every commit says why it rolls back
> to the one before."

**Fallback:** none needed. This is plain git.

---

## Act 5: The proof (3:20–4:00)

**Show** terminal 2: `docs/rollback-results.md`.

| From | To | Result |
|---|---|---|
| `main` | `split/1-expand` | **PASS** |
| `split/1-expand` | `split/2-migrate` | **PASS** |
| `split/2-migrate` | `split/3-contract` | **PASS** |
| `split/3-contract` | `split/4-drop` | **PASS** |
| `main` | `pr-482-minor-units` | **FAIL** |

**Say:**
> "Each row deploys for real, sends traffic, rolls back, and sends traffic again, through every mix of old and new
> versions. Four passes, one fail. And PR #482 fails *before* anyone presses rollback: a new consumer reading old
> events also books zero."
>
> "One-Way Door: it tells you before you merge whether you'll be able to roll back. Copy one folder into your
> repo, or install it as a Copilot plugin."

**If you have 50 spare seconds:** run one test live: `demo/scripts/rollback-test.sh split/2-migrate split/3-contract`.

**Fallback:** the table is a file. It doesn't depend on Docker.

---

## After the demo

```bash
demo/scripts/reset.sh      # ready for the next run
demo/scripts/down.sh       # or stop everything
```
