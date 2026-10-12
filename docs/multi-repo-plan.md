# Multi-repo demo: plan (draft v4 for review)

Status: **plan only, nothing built yet.** The target design is in [`architecture.md`](architecture.md).

Agreed so far:
- Kafka for queues.
- SWIFT is the only rail. GTX is the only component that talks to SWIFT.
- Postgres holds the routing rules (schema in the orchestrator repo, rows in a separate rules repo) and GTX's message log.
- Spanner and BigQuery are fed by data ingestion. There's no query service: a `status.sh` script reads them.
- Main act: B1, "The Rule Nobody Owned". Second act: B2, "The Field Nobody Owned".
- Local repos first, GitHub org later.

---

## 1. Repos (seven, side by side in `~/projects/northwind/`)

| Repo | Owns |
|---|---|
| `northwind-contracts` | message formats: pacs.008 subset, internal payment, lifecycle event, rule file format |
| `northwind-gtx-gateway` | GTX: validation, UETR de-duplication, message log, SWIFT ⇄ internal format |
| `northwind-inbound-orchestrator` | screening call, rules, RELEASE/HOLD, **`routing_rules` table schema** |
| `northwind-routing-rules` | **rule rows** (JSON files) + loader job |
| `northwind-swift-outbound` | next bank, cut-off, hand-off to GTX |
| `northwind-data-ingestion` | status events into Spanner and BigQuery |
| `northwind-platform` | docker compose, `saa-sim`, `screening-sim`, scripts (`up`, `traffic`, `status`, `deploy`, `incident`, `rollback-test`), release manifests, VS Code workspace |

The skill reaches all seven repos as a plugin (one install). When they move to GitHub, each repo also gets a copy of
`.github/skills` for the cloud agent.

## 2. Runtime

Everything runs in **docker compose**: Kafka, Postgres (`gtx` and `rules` databases), the Spanner and BigQuery
emulators, saa-sim, screening-sim, and five small Java services. That's roughly 4 to 5 GB, so **8 GB of Docker
memory should be enough.** All images run natively on Apple Silicon.

## 3. Happy path: done when

`traffic.sh 50` makes saa-sim send 50 pacs.008 messages, a few of them above the hold threshold. Then `status.sh` shows:
- 50 messages in GTX's log, with a redelivered duplicate parked, not processed twice;
- the large ones **HELD**: they never reach saa-sim's "sent" list;
- the rest **SENT** and ACKed, with the same UETR, in saa-sim, Spanner and BigQuery.

## 4. Act 1: B1, "The Rule Nobody Owned"

| Repo | PR | Change |
|---|---|---|
| `northwind-routing-rules` | **#517** | hold rule: `"holdAbove": 50000.00` → `"holdAboveMinor": 5000000` (renamed, now in pence) |
| `northwind-inbound-orchestrator` | #212 | reads `holdAboveMinor`, compares in pence |

1. v1 everywhere: large payments are held.
2. The rules loader deploys #517, then the orchestrator deploys #212. Holds still work.
3. An unrelated problem in #212 → on-call **rolls back the orchestrator only**. The rule rows stay.
4. The old code looks for `holdAbove`, finds nothing, and treats the rule as not applicable. No error.
5. **Punchline:** large payments go **straight out to SWIFT, unreviewed**. saa-sim ACKs them. The bank can now only
   *request* them back.
6. `status.sh`: N payments worth £X skipped the hold, and they show as SENT in Spanner and BigQuery. Nothing is red.

**The skill on PR #517** should say ONE-WAY, window *none*, and name `RuleEvaluator.java` in the orchestrator repo
as the code that reads `holdAbove`. It should report "checked 6 of 6 related repos".

**The safe split** (each step can be rolled back in either repo on its own):

| Step | routing-rules (data) | orchestrator (code) |
|---|---|---|
| 1. Expand | (none) | reads `holdAboveMinor`, else `holdAbove`; holds if neither |
| 2. Migrate | rule files carry both keys; the loader checks they agree | (none) |
| 3. Contract | (none) | reads only `holdAboveMinor`; still holds if missing |
| 4. Drop | remove `holdAbove` | (none) |

## 5. Act 2: B2, "The Field Nobody Owned" (short)

PRs in contracts, GTX and SWIFT outbound move the creditor address to structured fields (town, country) for the
November 2026 deadline. Data ingestion isn't changed, so Spanner and BigQuery fill with blank addresses. Rolling back
SWIFT outbound while messages are queued sends payments without a usable address. The skill on the contracts PR
names data ingestion as the unchanged reader.

## 6. Skill changes (in this repo)

1. `.github/one-way-door.yml` per repo: related repos (local path and GitHub name), what the repo owns, the deployed ref.
2. `find-readers.mjs`: searches related repos for keys, columns and topics, and reports hits and unreachable repos.
3. `data-compat` mode: renamed or removed keys in data files, and numbers scaled by 10, 100 or 1000.
4. SKILL.md step 5 uses `find-readers`, and assumes unreachable repos read.
5. The verdict line states its coverage.
6. New patterns: `reference-data-semantics-change`, `split-ownership-rollback`, `control-fails-open`,
   `external-network-message`, `spanner-schema-change`, `bigquery-schema-change`.

## 7. Phases (each ends with a commit and a shown "Done when")

| Phase | What | Done when |
|---|---|---|
| **M0** | Platform: compose, saa-sim, screening-sim | One `up.sh`; saa-sim sends a pacs.008 and records an outbound one |
| **M1** | Skill changes + tests | A rules-data change on fixture repos is flagged and its reader found in another repo |
| **M2** | The other six repos at v1 | Section 3 |
| **M3** | Act 1: PR branches + cross-repo `incident.sh` | Reproduces three times from clean |
| **M4** | Skill on #517, the split, cross-repo `rollback-test.sh` | The skill names `RuleEvaluator.java`; matrix shows 4 PASS, 1 FAIL |
| **M5** | Act 2, README, demo script, `reset.sh`, Copilot checklist | Reset in under a minute; rehearsed |

## 8. Open questions

1. **The hold rule's framing.** £50,000 four-eyes review is unusual for automated forwarding. Alternatives are
   treasury release above about £1 million, or a high-risk corridor review. The story works the same either way.
2. What does your real GTX do beyond bridging? We can mirror it.
3. Rule file format: JSON (planned) or YAML?
