# Multi-repo demo: plan (draft v3 for review)

Status: **plan only, nothing built yet.** The target design is in [`architecture.md`](architecture.md). This page
says how we build it and what the demo shows.

Agreed so far:
- Kafka for queues (it also plays the MQ queues on the SWIFT side).
- SWIFT is the only payment rail. The bank acts as an intermediary: receive pacs.008, check it, forward it.
- **GTX (Gateway Exchange)** is the only component that talks to the SWIFT interface.
- Postgres holds routing rules (schema in the orchestrator repo, rows in a separate rules repo) and GTX's message log.
- Outbound feeds Spanner and BigQuery through `payments.lifecycle.v1` and a data-ingestion service.
- Main act: **B1, "The Rule Nobody Owned"**. Second act: **B2, "The Field Nobody Owned"** (structured addresses).
- Local repos first, pushed to a GitHub org later.

---

## 1. Repos (eight, side by side in `~/projects/northwind/`)

| Repo | Owns |
|---|---|
| `northwind-contracts` | pacs.008 subset (XSD-lite), `PaymentInstruction`, `OutboundPayment`, `PaymentLifecycleEvent`, rule file format |
| `northwind-gtx-gateway` | GTX: MQ ⇄ Kafka bridge, pacs.008 validation, UETR de-duplication, message log (`gtx` database), pacs.008 ⇄ canonical |
| `northwind-inbound-orchestrator` | screening call, rules evaluation, HOLD/RELEASE, **`routing_rules` schema** (Flyway), approve endpoint (stretch) |
| `northwind-routing-rules` | **rule data** (one JSON file per rule) + loader job |
| `northwind-swift-outbound` | next agent, charges, cut-off, hand-off to GTX |
| `northwind-data-ingestion` | lifecycle events into Spanner and BigQuery; owns their DDL and schema |
| `northwind-payquery` | REST API over Spanner and BigQuery; runs on kind (compose fallback) |
| `northwind-platform` | compose + kind, **saa-sim** (Alliance Access, SWIFT network and other banks), **screening-sim**, scripts, release manifests, VS Code workspace |

The skill reaches these repos **as a plugin** (one install covers all eight). When they're pushed to GitHub, each repo
also gets a copy of `.github/skills` for the cloud agent.

## 2. Runtime

| Piece | Stand-in |
|---|---|
| SWIFT network, Alliance Access, other banks | `saa-sim` (Kafka topics named like MQ queues; ACK/NAK; a "sent" log; recall answers in stretch) |
| Screening engine | `screening-sim` (list lookup; configurable delay and outage) |
| Queues | Kafka 4.1 (KRaft) |
| Postgres | PostgreSQL 16: databases `gtx` and `rules` |
| Spanner / BigQuery | Google's Spanner emulator / community `bigquery-emulator` |
| GKE | kind (PayQuery only) |

All images run natively on Apple Silicon. About seven Java services plus Kafka, Postgres, the two emulators and kind
come to roughly 6 to 7 GB. **Docker Desktop at 10 GB** gives headroom. kind is the first thing to drop if needed.

## 3. Happy path: done when

`traffic.sh 50` makes saa-sim deliver 50 pacs.008 messages, a few of them above £50,000:
- GTX logs 50 messages, and a redelivered duplicate is parked, not processed twice;
- the high-value ones are **HELD**, never reach `saa.outbound`, and show as HELD in PayQuery;
- the rest leave as pacs.008 with the same UETR, get an ACK from saa-sim, and show as SENT in Spanner, BigQuery and PayQuery.

## 4. Act 1: story B1, "The Rule Nobody Owned"

| Repo | PR | Change |
|---|---|---|
| `northwind-routing-rules` | **#517** | `HIGH_VALUE_HOLD` params `"holdAbove": 50000.00` → `"holdAboveMinor": 5000000` (key renamed, unit changed) |
| `northwind-inbound-orchestrator` | #212 | reads `holdAboveMinor` and compares in pence |

1. v1 everywhere: high-value payments are held.
2. The loader deploys #517, then the orchestrator deploys #212. Holds still work.
3. An unrelated problem in #212 → on-call **rolls back the orchestrator only**. The rule rows stay, because they
   were deployed from another repo.
4. The old code reads `params.holdAbove`, finds nothing, and treats the rule as not applicable. No error.
5. **Punchline:** payments of £60,000, £250,000 and so on pass screening and go **straight out to SWIFT, unreviewed**.
   saa-sim ACKs them. The bank can now only *request* a recall, and once the money is credited that needs the
   beneficiary's consent.
6. `status.sh`: N payments worth £X bypassed four-eyes review. PayQuery shows SENT, and every dashboard is green.

**The skill on PR #517** (in `northwind-routing-rules`) should say ONE-WAY, window *none* (it closes when the loader
runs), name `RuleEvaluator.java` in the orchestrator repo as the reader of `holdAbove`, and report "checked 7 of 7
related repos".

**The safe split** (each step can be rolled back in either repo on its own):

| Step | routing-rules (data) | orchestrator (code) |
|---|---|---|
| 1. Expand | (none) | reads `holdAboveMinor`, else `holdAbove`; **holds if neither** (fail closed) |
| 2. Migrate | rule files carry both keys; the loader checks `holdAboveMinor == holdAbove × 100` | (none) |
| 3. Contract | (none) | reads only `holdAboveMinor`; still fails closed |
| 4. Drop | remove `holdAbove` | (none) |

## 5. Act 2: story B2, "The Field Nobody Owned" (short)

PRs in contracts, GTX and SWIFT outbound move the creditor address from unstructured lines to structured or hybrid
(`TwnNm`, `Ctry`), for the November 2026 CBPR+ deadline. Data ingestion and PayQuery weren't changed, so Spanner and
BigQuery fill with blank addresses. When SWIFT outbound is rolled back with messages queued, payments leave without a
usable address. The skill on the contracts PR names data ingestion and PayQuery as unchanged readers.

## 6. Skill changes (in this repo)

1. `.github/one-way-door.yml` per repo: related repos (local path and GitHub name), what the repo owns, the deployed ref.
2. `find-readers.mjs`: search related repos at their deployed ref for keys, columns and topics (snake and camel
   variants). It reports hits and unreachable repos.
3. `data-compat` mode in `schema-compat.mjs`: keys removed or renamed in data files, and numbers at the same path
   scaled by 10, 100 or 1000.
4. SKILL.md step 5 uses `find-readers`, and assumes unreachable repos read.
5. The verdict line states its coverage: "checked 7 of 7 related repos".
6. New patterns: `reference-data-semantics-change`, `split-ownership-rollback`, `control-fails-open`,
   `external-network-message`, `spanner-schema-change`, `bigquery-schema-change`, `rolling-update-mixed-versions`.

## 7. Phases (each ends with a commit and a shown "Done when")

| Phase | What | Done when |
|---|---|---|
| **M0** | Platform: compose (Kafka, Postgres, emulators), saa-sim, screening-sim, kind | One `up.sh`; saa-sim emits a pacs.008 and records an outbound one; screening-sim answers |
| **M1** | Skill: config, `find-readers.mjs`, `data-compat`, SKILL.md, coverage, patterns + tests | Tests green; on fixture repos a rules-data change is flagged and its reader found in another repo |
| **M2** | The other seven repos at v1 and the happy path | Section 3 |
| **M3** | Act 1: the two PR branches, cross-repo `incident.sh` | Reproduces three times from clean |
| **M4** | The skill on #517, the split across both repos, release manifests, cross-repo `rollback-test.sh` | The skill names `RuleEvaluator.java`; the matrix shows 4 PASS, 1 FAIL |
| **M5** | Act 2 (B2), README, demo script, `reset.sh`, workspace, Copilot checklist | Reset in under a minute; rehearsed end to end |

M0 to M3 is a demo-able incident. M4 is the proof. M5 adds the topical second act.

## 8. Risks

- **BigQuery emulator gaps:** keep to simple inserts and a view.
- **Memory:** see section 2.
- **Demo length:** act 1 is the four minutes. Act 2 is a 30-second "and this is happening in your estate this month".
- **Message realism:** pacs.008 is a subset. That's said on stage (architecture.md section 9).

## 9. Open questions (not blocking M0)

1. What does your real GTX do beyond bridging (transformation, validation, routing)? We can mirror it.
2. Rule file format: JSON (planned) or YAML?
3. PayQuery as REST (planned) or gRPC?
