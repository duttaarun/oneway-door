# Multi-repo demo: plan (draft for review)

Status: **plan only, nothing built yet.** Agreed so far: Kafka for queues, a change-data-capture (CDC) sync that we
design, headline story B ("The Column Nobody Owned"), and local repos first, pushed to a GitHub org later.

## Goal

Show One-Way Door working across **several repos**, the way a payments platform is really split, on a laptop:

- a PR in one repo (the SQL repo) is judged against code in **four other repos**;
- the incident happens for real, across repos;
- the safe split spans repos, and a cross-repo rollback test proves it.

Everything stays invented: **Northwind Payments**, made-up banks, made-up accounts and amounts.

---

## 1. Repos

All seven live side by side in `~/projects/northwind/`, each its own git repo. They'll be pushed to a GitHub org later.

| Repo | Owns | Mirrors |
|---|---|---|
| `northwind-contracts` | JSON Schemas for events (CDC payload, SWIFT-out record), simplified pacs.008 layout, inbound file layout | shared contracts |
| `northwind-payments-db` | **PostgreSQL migrations only** (Flyway), plus a migration runner image | the separate SQL repo |
| `northwind-gtx-gateway` | inbound: reads `swift.inbound` (Kafka) and files from bucket `northwind-inbound`, validates, inserts into `payments` | GTX gateway |
| `northwind-swift-outbound` | outbound: consumes CDC events for payments ready to send, builds pacs.008 XML, writes to `swift.outbound` (Kafka) and bucket `northwind-swift-out` | outbound to SWIFT |
| `northwind-data-sync` | consumes CDC events, upserts Spanner `Payments`, appends BigQuery `payments_history`, owns Spanner DDL and BigQuery schema | Datastream/Dataflow layer |
| `northwind-payquery` | query API on Kubernetes: recent payments from Spanner, history from BigQuery | PayQuery on GKE |
| `northwind-platform` | compose + kind setup, Debezium config, fake SWIFT sink, deploy/rollback/incident/rollback-test scripts, the VS Code multi-root workspace | infra repo |

The current `one-way-door` repo stays the home of the skill. The Northwind repos get it **as a plugin** (one install
covers all seven), which also shows off the "pluggable" route. The repos are pushed to GitHub before the cloud agent
is tried. The cloud agent doesn't load plugins, so each repo then also gets a copy of `.github/skills`.

## 2. Runtime (one laptop)

| Piece | Local stand-in | Runs in |
|---|---|---|
| Message queues | Kafka 4.1 (KRaft) | compose |
| File store | `fake-gcs-server` (GCS API) | compose |
| Transactional DB | PostgreSQL 16 with `wal_level=logical` | compose |
| CDC | **Debezium 3.2** (Kafka Connect, Postgres connector) | compose |
| Spanner | Google's Spanner emulator | compose |
| BigQuery | community `bigquery-emulator` | compose |
| SWIFT network | `swift-sink` (a small service in `northwind-platform`: records every message "sent", never lets you take one back) | compose |
| GKE | `kind` cluster running PayQuery (real rolling updates, `kubectl rollout undo`) | kind |
| Services | gateway, outbound, data-sync, payquery (Java 21, Spring Boot 3.5) | compose (payquery: kind) |

All of these images were checked: they run natively on Apple Silicon.

**Memory:** Docker Desktop has 8 GB today. Five JVMs, Kafka, Kafka Connect, three emulators and a kind node need
about 7 to 9 GB. **Raise Docker Desktop to 12 GB** (Settings → Resources) before phase M2. If that isn't possible,
PayQuery falls back to compose and kind becomes optional.

## 3. The v1 flow (happy path)

```
external file / message ─► gtx-gateway ─► payments (Postgres)
                                              │  Debezium CDC  (topic cdc.payments)
                     ┌────────────────────────┼─────────────────────────┐
                     ▼                        ▼                         ▼
              swift-outbound             data-sync ──► Spanner       (anyone else
                     │                        └──────► BigQuery       subscribed)
                     ▼                                    │
      swift.outbound + bucket ─► swift-sink          payquery (kind)
```

`payments` v1 (in `northwind-payments-db`, `V1__payments.sql`):

| column | type | note |
|---|---|---|
| `payment_id` | uuid | primary key |
| `uetr` | uuid | SWIFT end-to-end reference, unique |
| `status` | varchar | RECEIVED → READY → SENT |
| `amount`, `currency` | numeric(18,2), char(3) | |
| `debtor_name`, `debtor_iban` | | |
| `creditor_name`, `creditor_iban` | | |
| **`creditor_address`** | text | unstructured address lines, as most payments carry them today |
| `received_at`, `updated_at` | timestamptz | |

Debezium publishes every row change as JSON with **every column as a field**. That's the hidden contract: the table's
shape *is* the event's shape, so a column change in the SQL repo silently changes an event that three other repos read.

**Done-when for v1:** `traffic.sh 50` sends 50 instructions (half as Kafka messages, half as files). 50 rows land
in Postgres, 50 pacs.008 messages *with addresses* land in swift-sink, and PayQuery returns all 50 with addresses
from Spanner and BigQuery.

## 4. Story B: "The Column Nobody Owned"

**The change.** ISO 20022 prefers structured postal addresses, so three teams raise three tidy PRs:

| Repo | PR | Change |
|---|---|---|
| `northwind-payments-db` | **#517** | `V31__structured_creditor_address.sql`: add `creditor_street`, `creditor_town`, `creditor_postcode`, `creditor_country`, **parse the old text into them in place** (some won't parse), then **drop `creditor_address`** |
| `northwind-gtx-gateway` | #212 | writes the structured columns |
| `northwind-swift-outbound` | #88 | builds `<PstlAdr>` with structured fields |

`northwind-data-sync` and `northwind-payquery` aren't touched. Nobody thought they read that column: they read the
CDC events. All tests pass in all three repos.

**The incident** (`northwind-platform/scripts/incident.sh`):

1. v1 everywhere. Payments flow; SWIFT messages carry addresses; PayQuery shows them.
2. Deploy #517 (the migration runs), then #212 and #88.
3. **First symptom:** PayQuery shows blank beneficiary addresses. data-sync maps `creditor_address` from the CDC
   event, and the field has vanished. No errors.
4. **Second symptom:** outbound #88's address formatting misbehaves (some towns didn't parse), and the
   swift-sink validation rejects a few messages. On-call rolls back **swift-outbound only**.
5. **The punchline:** outbound v1 reads the CDC events, finds no `creditor_address` (null, no exception), and sends
   pacs.008 messages to SWIFT **with no beneficiary address at all**. swift-sink records them as delivered.
   You can't recall a message from SWIFT.
6. `status.sh`: N payments sent without an address, PayQuery showing blanks, the original address text **gone from
   Postgres** (dropped after a lossy parse), and nothing in any dead-letter topic.

**Why it's one-way:** the original addresses are destroyed (lossy in-place conversion + drop), the CDC events changed
shape for every subscriber, and what reached SWIFT can't be undone.

**What the skill should say on PR #517** (run in `northwind-payments-db`): ONE-WAY, safe window *none*. The blast
radius lists **swift-outbound, data-sync, payquery (via Spanner/BigQuery) and gateway, in four other repos**, found
through the CDC topic and the column name. Coverage: "checked 5 of 5 related repos".

## 5. The safe split, across repos

| Step | payments-db | gateway | outbound | data-sync | payquery |
|---|---|---|---|---|---|
| 1. Expand | add structured columns, nullable | writes both | (none) | maps new fields if present | (none) |
| 2. Migrate | backfill structured; **unparseable rows flagged for repair, originals kept** | (none) | (none) | backfills Spanner/BigQuery | (none) |
| 3. Contract | (none) | (none) | builds structured `<PstlAdr>`, falls back to lines | reads structured | shows structured |
| 4. Drop | drop `creditor_address` once every consumer is on step 3 | stops writing old | (none) | (none) | (none) |

Each step rolls back to the one before. A **release manifest** in `northwind-platform` says which version of each repo
makes up "step N", and `rollback-test.sh` deploys and rolls back whole manifests. Expected result: 4 PASS, and
PR #517 + #212 + #88 FAIL.

## 6. Skill changes (in this repo)

1. **`.github/one-way-door.yml`** in each repo:
   ```yaml
   related:                       # where else to look for readers and writers
     - name: northwind-swift-outbound
       path: ../northwind-swift-outbound      # local clone (VS Code workspace / CLI)
       github: northwind/northwind-swift-outbound   # for GitHub code search (cloud agent)
   owns:
     tables: [payments]
     topics: [cdc.payments]
   contracts: ../northwind-contracts
   deployed_ref: main             # what "currently running" means in each related repo
   ```
2. **New script `find-readers.mjs`** (Node stdlib, JSON out, exit 0). Given identifiers (table, columns, topics, event
   fields, with snake and camel variants), it searches each related repo **at its deployed ref** and reports matches
   by repo, file and line. It also reports repos it couldn't reach. This makes the blast radius mechanical.
3. **SKILL.md step 5:** run `find-readers`, then judge each hit. If a related repo can't be reached, say so and assume
   it reads.
4. **Verdict coverage:** `Blast radius: checked 5 of 5 related repos` (or "3 of 5; 2 unreachable").
5. **New patterns:** `cdc-table-as-contract`, `external-network-message` (SWIFT and partners: can't recall),
   `spanner-schema-change`, `bigquery-schema-change`, `rolling-update-mixed-versions`, `file-layout-change`.
6. **scan-migrations:** Spanner DDL and BigQuery DDL folders.

## 7. Phases (each ends with a commit and a shown "Done when")

| Phase | What | Done when |
|---|---|---|
| **M0** | Platform skeleton: compose with Postgres, Kafka, Debezium, fake-gcs, Spanner and BigQuery emulators, swift-sink. kind cluster. | Every piece healthy from one `up.sh`. Debezium emits a CDC event for a hand-inserted row. |
| **M1** | Skill: config file, `find-readers.mjs` + tests, SKILL.md step 5, coverage line, new patterns, Spanner/BigQuery DDL | Tests green. `find-readers` on fixture repos finds readers across three repos. |
| **M2** | The seven repos at v1, plus the happy path | The v1 done-when in section 3. |
| **M3** | Story B: the three PR branches and the cross-repo `incident.sh` | The incident reproduces three times from clean, ending with messages in swift-sink with no address. |
| **M4** | Skill run on #517, the split across repos, release manifests, cross-repo `rollback-test.sh` | The skill names all four other repos. The rollback matrix shows 4 PASS, 1 FAIL. |
| **M5** | README, 4-minute demo script, `reset.sh`, multi-root VS Code workspace, Copilot checklist | Reset in under a minute. Rehearsed end to end. |

M0 to M3 alone are already demo-able ("here's the incident across repos"). M4 is the proof.

## 8. Risks and how we handle them

- **BigQuery emulator fidelity:** it's a community project and not every DDL behaves like real BigQuery. We keep
  BigQuery to simple tables and inserts, and note it in the README.
- **Laptop memory:** see section 2. kind is the first thing to drop if needed.
- **Demo length:** five services and a cross-repo story could overrun 4 minutes. The incident script compresses it
  the same way as today, and the deep dive moves to a backup video.
- **Message formats:** pacs.008 is simplified (only the elements the story needs). Real ISO 20022 validation is out
  of scope.

## 9. Open questions (answers welcome, not blocking M0)

1. Real pacs.008, or MT103 as well? (Plan: pacs.008 only.)
2. Any real queue or topic naming conventions you'd like mirrored? (Plan: invented names.)
3. Should PayQuery be REST or gRPC? (Plan: REST.)
