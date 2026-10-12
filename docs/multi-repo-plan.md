# Multi-repo demo: plan (draft v2 for review)

Status: **plan only, nothing built yet.**

Agreed so far:
- Kafka for queues.
- SWIFT is the only payment engine.
- Postgres holds **routing rules only**, local to the inbound orchestrator.
- **Mixed ownership:** the rule table's schema lives in the orchestrator repo, and the rule data in a separate rules repo.
- Outbound feeds Spanner and BigQuery through a queue and a data-ingestion service. There is no CDC.
- Headline story: **B1, "The Rule Nobody Owned"**.
- Local repos first, pushed to a GitHub org later.

## Goal

Show One-Way Door working across **several repos**, the way the payments platform is really split, on one laptop:

- a PR in one repo (here, rule data) is judged against code in **another repo** that reads it;
- the incident happens for real, across repos, and ends with something that can't be recalled;
- the safe split spans repos, and a cross-repo rollback test proves it.

Everything is invented: **Northwind Payments**, made-up banks, accounts and amounts.

---

## 1. Architecture

```
 SWIFT in ─► Kafka swift.inbound ─► inbound-orchestrator ◄── routing_rules (Postgres)
                                          │                      ▲ schema: orchestrator repo
                                          │                      └ rows:   routing-rules repo (loader job)
                     HOLD (four-eyes) ◄───┤
                                          ▼ Kafka payments.routed
                                    swift-outbound ─► SWIFT engine (fake: records, can't recall)
                                          │
                                          ▼ Kafka payments.outcome
                                    data-ingestion ─► Cloud Spanner (emulator)
                                                   └► BigQuery (emulator)
                                                          ▼
                                                 payquery (Kubernetes / kind)
```

## 2. Repos

All seven sit side by side in `~/projects/northwind/`, each its own git repo.

| Repo | Owns | Mirrors |
|---|---|---|
| `northwind-contracts` | JSON Schemas: inbound SWIFT payment (simplified pacs.008), `RoutedPayment`, `PaymentOutcome`, and the **rule file format** | shared contracts |
| `northwind-inbound-orchestrator` | consumes `swift.inbound`, loads rules from Postgres, decides RELEASE or HOLD, publishes `payments.routed` or `payments.held`. **Owns the `routing_rules` schema** (Flyway). | inbound orchestrator |
| `northwind-routing-rules` | **the rule data**: one JSON file per rule, plus a loader job that upserts them into `routing_rules`. Deployed on its own schedule. | the separately-managed rules |
| `northwind-swift-outbound` | consumes `payments.routed`, sends to the SWIFT engine, publishes `payments.outcome` | outbound microservice |
| `northwind-data-ingestion` | consumes `payments.outcome` (and `payments.held`), writes Spanner `Payments` and BigQuery `payments_history` | data-ingestion microservices |
| `northwind-payquery` | REST API on Kubernetes: a payment's status from Spanner, history from BigQuery | PayQuery on GKE |
| `northwind-platform` | compose + kind, the fake SWIFT engine, deploy/rollback/incident/rollback-test scripts, release manifests, VS Code multi-root workspace | infra repo |

The current `one-way-door` repo stays the home of the skill. The Northwind repos get it **as a plugin** (one install
covers all seven). When they move to GitHub, each repo also gets a copy of `.github/skills`, because the cloud agent
doesn't load plugins.

## 3. Runtime (one laptop)

| Piece | Local stand-in | Runs in |
|---|---|---|
| Queues | Kafka 4.1 (KRaft) | compose |
| Rules DB | PostgreSQL 16 | compose |
| Cloud Spanner | Google's Spanner emulator | compose |
| BigQuery | community `bigquery-emulator` | compose |
| SWIFT | `swift-engine`: records every message, exposes what it received, has no recall | compose |
| GKE | `kind` cluster running PayQuery (real rolling updates, `kubectl rollout undo`) | kind |
| Services | orchestrator, swift-outbound, data-ingestion, payquery (Java 21, Spring Boot 3.5); rules loader (job) | compose / kind |

All images were checked: they run natively on Apple Silicon. Without Debezium and with one outbound service, this
fits in about 7 GB. **Raise Docker Desktop to 10 GB** (Settings → Resources) for headroom. kind is optional if memory
is tight: PayQuery can run in compose instead.

## 4. v1: the happy path

**`routing_rules`**: schema in the orchestrator repo (`V1__routing_rules.sql`):

| column | type |
|---|---|
| `rule_id` | varchar, primary key |
| `rule_type` | varchar (`HIGH_VALUE_HOLD`, `SANCTIONED_COUNTRY_BLOCK`, …) |
| `priority` | int |
| `params` | **jsonb**: each rule type has its own parameters |
| `enabled` | boolean |

**Rule data**: rule files in the rules repo, for example `rules/high-value-hold-gbp.json`:

```json
{ "ruleId": "HV-GBP", "ruleType": "HIGH_VALUE_HOLD", "priority": 10,
  "params": { "currency": "GBP", "holdAbove": 50000.00 } }
```

The orchestrator holds any GBP payment above £50,000 for four-eyes review and releases the rest to SWIFT.

**Done when:** `traffic.sh 50` sends 50 SWIFT payments, including a few above £50,000. The high-value ones show as
**HELD** in PayQuery and never reach the SWIFT engine. The rest show as **SENT** in PayQuery, Spanner and BigQuery,
and in the engine's log.

## 5. Story B1: "The Rule Nobody Owned"

**The change.** Money as decimals is a rounding risk, so two teams move rule thresholds to minor units:

| Repo | PR | Change |
|---|---|---|
| `northwind-routing-rules` | **#517** | rule params change from `"holdAbove": 50000.00` to `"holdAboveMinor": 5000000`: the **key is renamed and the unit changes** |
| `northwind-inbound-orchestrator` | #212 | reads `holdAboveMinor` and compares it with the amount in pence |

Both PRs are tidy and both repos' tests pass. Each team owns half of the meaning.

**The incident** (`northwind-platform/scripts/incident.sh`):

1. v1 everywhere. High-value payments are held, and the rest go to SWIFT.
2. The loader deploys #517 (new rule rows), then the orchestrator deploys #212. Holds still work.
3. An unrelated problem in orchestrator #212 (for example, a slow new rule) makes on-call **roll back the
   orchestrator only**. The rule data stays: it was deployed separately, from another repo.
4. Old orchestrator code reads `params.holdAbove`, finds nothing, and treats the rule as **not applicable**. It
   throws no error, logs no warning, and puts nothing in a dead-letter topic.
5. **The punchline:** traffic includes payments of £60,000, £250,000 and so on. They are **released straight to
   SWIFT without review**. The engine records them as sent. You can't recall a payment from SWIFT.
6. `status.sh`: N payments worth £X bypassed four-eyes review, PayQuery shows them as SENT, and every dashboard is green.

**Why it's one-way:** the code rolled back, but the rule data (another repo, another deploy) didn't. What reached
SWIFT can't be undone.

**Why it's hard to catch:** the rules PR changes **data, not schema**. A migration scanner sees nothing. Only someone
who reads the orchestrator's code in the other repo knows that `holdAbove` must still exist.

**What the skill should say on PR #517** (run in `northwind-routing-rules`): ONE-WAY, safe window *none* (closes when
the loader runs). Finding: rule parameter `holdAbove` removed and `holdAboveMinor` added, with a ×100 unit change.
Blast radius: **`RuleEvaluator.java` in `northwind-inbound-orchestrator` reads `holdAbove`**, so the previous release
silently skips the hold. Coverage: "checked 6 of 6 related repos".

## 6. The safe split, across repos

| Step | routing-rules (data) | orchestrator (code) |
|---|---|---|
| 1. Expand | (none) | reads `holdAboveMinor` if present, otherwise `holdAbove`. **Fails closed**: if neither exists, holds the payment. |
| 2. Migrate | rule files carry **both** keys. The loader checks they agree (`holdAboveMinor == holdAbove × 100`). | (none) |
| 3. Contract | (none) | reads only `holdAboveMinor`. Still fails closed if it's missing. |
| 4. Drop | remove `holdAbove` | (none) |

Each step rolls back to the one before, **in either repo**. That's the extra rule for split ownership: the data repo
and the code repo can each be rolled back without the other. A **release manifest** in `northwind-platform` pins one
version per repo for each step, and `rollback-test.sh` deploys, sends traffic and rolls back each repo in turn.
Expected: 4 PASS, and #517 + #212 FAIL.

Teaching point for the pitch: **controls must fail closed.** A hold rule that can't read its threshold should hold,
not release.

## 7. Skill changes (in this repo)

1. **`.github/one-way-door.yml`** in each repo:
   ```yaml
   related:
     - name: northwind-inbound-orchestrator
       path: ../northwind-inbound-orchestrator          # local clone (VS Code workspace / CLI)
       github: northwind/northwind-inbound-orchestrator # GitHub code search (cloud agent)
   owns:
     data: [routing_rules.params]       # what this repo writes
     topics: []
   contracts: ../northwind-contracts
   deployed_ref: main
   ```
2. **New script `find-readers.mjs`** (Node stdlib, JSON out, exit 0). Given identifiers (keys, columns, topics, with
   snake and camel variants), it searches each related repo **at its deployed ref** and reports hits by repo, file
   and line, plus repos it couldn't reach.
3. **New script mode `data-compat`** (an extension of `schema-compat`). It compares JSON/YAML data files between base
   and head: keys removed or renamed, and **numbers at the same path scaled by 10, 100 or 1000** (a likely unit
   change). This gives the rules PR a mechanical finding even though it has no schema change.
4. **SKILL.md step 5:** run `find-readers`, judge each hit, and if a repo can't be reached, say so and assume it reads.
5. **Verdict coverage:** `Blast radius: checked 6 of 6 related repos`.
6. **New patterns:** `reference-data-semantics-change` (rule or config data changes meaning),
   `split-ownership-rollback` (schema in one repo, data in another), `control-fails-open`,
   `external-network-message` (SWIFT: can't recall), `spanner-schema-change`, `bigquery-schema-change`,
   `rolling-update-mixed-versions`.

## 8. Phases (each ends with a commit and a shown "Done when")

| Phase | What | Done when |
|---|---|---|
| **M0** | Platform skeleton: compose (Kafka, Postgres, Spanner and BigQuery emulators, swift-engine) and a kind cluster | Everything healthy from one `up.sh`. A test message reaches each piece. |
| **M1** | Skill: config file, `find-readers.mjs`, `data-compat` + tests, SKILL.md step 5, coverage line, new patterns | Tests green. On fixture repos, a rules-data change is flagged and its reader found in another repo. |
| **M2** | The seven repos at v1, plus the happy path | Section 4's done-when. |
| **M3** | Story B1: the two PR branches and the cross-repo `incident.sh` | Reproduces three times from clean: high-value payments reach the SWIFT engine unreviewed, with no errors. |
| **M4** | Skill run on #517, the split across both repos, release manifests, cross-repo `rollback-test.sh` | The skill names the orchestrator's `RuleEvaluator.java`. The matrix shows 4 PASS, 1 FAIL. |
| **M5** | README, 4-minute demo script, `reset.sh`, multi-root VS Code workspace, Copilot checklist | Reset in under a minute. Rehearsed end to end. |

M0 to M3 alone are demo-able. M4 is the proof.

## 9. Risks

- **BigQuery emulator fidelity:** a community project. Keep to simple tables and inserts.
- **Memory:** see section 3. kind is the first thing to drop.
- **Demo length:** the incident script compresses time as today. The deep dive goes to the backup video.
- **Message formats:** a simplified pacs.008 (only what the story needs). No real ISO 20022 validation.
- **Story B2** ("The Field Nobody Owned": a message change that blanks Spanner, BigQuery and PayQuery) stays a
  possible second scenario once B1 works. The same repos support it.

## 10. Open questions (not blocking M0)

1. The rule file format: JSON (planned) or YAML?
2. Should the four-eyes approval be visible in the demo (an "approve" call releasing a held payment), or just shown
   as HELD? (Planned: shown as HELD, with an approve endpoint as a stretch goal.)
3. PayQuery as REST (planned) or gRPC?
