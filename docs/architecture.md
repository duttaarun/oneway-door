# Northwind Payments: target architecture (hackathon)

A realistic, laptop-sized model of how a UK bank receives SWIFT payments, processes them and sends them on. It is
the stage for the multi-repo One-Way Door demo. **Northwind Payments** and every bank, account and amount in it are
invented.

The bank in this model acts as an **intermediary**: it receives cross-border payments over SWIFT, checks them, and
forwards them to the next bank in the chain. That's the classic serial correspondent flow. All payment messages are
ISO 20022 (CBPR+). MT payment instructions ended on 22 November 2025.

---

## 1. The big picture

```
 ZONE 0  EXTERNAL            ZONE 1  SWIFT SECURE ZONE        ZONE 2  INTEGRATION
 ─────────────────           ─────────────────────────        ─────────────────────────────────────────
 Other banks                 Alliance Connect (VPN)            GTX: Gateway Exchange
   │  pacs.008 in            Alliance Gateway (HSM)             • MQ/file bridge  ⇄ Alliance Access
   ▼                         Alliance Access                    • validate CBPR+ pacs.008
 SWIFT network ───────────►  (routing points, MQ queues) ─MQ─►  • de-duplicate on UETR (message log)
   ▲                                  ▲  ◄──ACK/NAK──            • transform pacs.008 ⇄ canonical JSON
   │  pacs.008 out                    └──────────MQ────────────  • format outbound pacs.008
   │                                                                   │                ▲
   │                                                     payments.inbound.v1    payments.outbound.v1
 ZONE 3  PAYMENT PROCESSING                                            ▼                │
 ───────────────────────────────────────────────────────────────────────────────────────────────────
   Inbound orchestrator (payment hub) ◄── routing rules (Postgres)  ◄── rules data (loader job)
     • enrich (BIC directory)            schema: orchestrator repo        rows: routing-rules repo
     • sanctions screening ──► Screening service (fail closed)
     • apply rules: RELEASE / HOLD / REJECT
          │ HOLD ─► payments.held.v1 ─► four-eyes approval ─► release
          ▼ RELEASE
     payments.routed.swift.v1 ─► SWIFT outbound service (next agent, charges, cut-off) ─► payments.outbound.v1

 ZONE 4  DATA AND QUERY (GCP)
 ───────────────────────────────────────────────────────────────────────────────────────────────────
   every service ─► payments.lifecycle.v1 ─► Data ingestion ─► Cloud Spanner (live state, by UETR)
                                                            └► BigQuery (history, reporting)
                                                                      ▼
                                                             PayQuery API (GKE)
```

**Rule of the secure zone:** only GTX talks to Alliance Access. No other service has SWIFT access. That mirrors
SWIFT's Customer Security Programme, and it makes GTX the single choke point for every message format change.

---

## 2. Components

| Zone | Component | What it does | Real-world equivalent | Demo stand-in | Repo |
|---|---|---|---|---|---|
| 0 | SWIFT network + other banks | carries messages; other banks send and receive | SWIFTNet FINplus, correspondent banks | `saa-sim` (part 2) | `northwind-platform` |
| 1 | SWIFT interface | network connection, signing, message validation, routing to back office over MQ or files | Alliance Connect, Gateway, Access (MQ Host Adapter) | `saa-sim`: Kafka topics named like MQ queues, ACK/NAK, delivery notices, a "sent" log | `northwind-platform` |
| 2 | **GTX: Gateway Exchange** | bridge MQ ⇄ Kafka, validate pacs.008, UETR de-duplication, message log, pacs.008 ⇄ canonical | the bank's payments gateway | Spring Boot service + `gtx` Postgres database | `northwind-gtx-gateway` |
| 3 | Inbound orchestrator | enrich, screen, apply rules, route or hold | payment hub (payments engine) | Spring Boot service | `northwind-inbound-orchestrator` |
| 3 | Routing rules | rule data (thresholds, cut-offs, blocks) | rules managed by the business or an admin UI | JSON rule files + loader job into the `rules` database | `northwind-routing-rules` |
| 3 | Screening | sanctions and embargo checks | vendor screening engine | `screening-sim`: name and country lists, configurable latency and outage | `northwind-platform` |
| 3 | Four-eyes approval | a second person releases held payments | payments operations workbench | `POST /holds/{uetr}/approve` on the orchestrator (stretch goal) | `northwind-inbound-orchestrator` |
| 3 | SWIFT outbound | picks the next agent, charges and value date, checks cut-offs, hands the payment to GTX | outbound payment service per rail | Spring Boot service | `northwind-swift-outbound` |
| 4 | Data ingestion | lifecycle events into Spanner and BigQuery | ingestion microservices | Spring Boot service | `northwind-data-ingestion` |
| 4 | Cloud Spanner | live payment state and timeline, keyed by UETR | Cloud Spanner | Google's Spanner emulator | (data-ingestion owns DDL) |
| 4 | BigQuery | history and reporting | BigQuery | community `bigquery-emulator` | (data-ingestion owns schema) |
| 4 | PayQuery | REST: a payment by UETR, search, timeline | PayQuery on GKE | Spring Boot on `kind` (compose fallback) | `northwind-payquery` |
| x | Contracts | message schemas and canonical model | shared contracts | JSON Schema + an XSD-lite for pacs.008 | `northwind-contracts` |
| x | Platform | Kafka, Postgres, emulators, simulators, scripts | infrastructure | compose + kind | `northwind-platform` |

---

## 3. Message flows

### 3.1 Happy path: receive, check, forward

| # | From → to | Over | Message |
|---|---|---|---|
| 1 | other bank → SWIFT → Alliance Access | SWIFT | `pacs.008` (CBPR+), with a UETR |
| 2 | Alliance Access → GTX | MQ queue (`saa.inbound`) | raw XML |
| 3 | GTX | | validate, check the UETR against the message log (duplicate → park), store, transform |
| 4 | GTX → orchestrator | `payments.inbound.v1` | canonical `PaymentInstruction` JSON |
| 5 | orchestrator → screening | sync call | names, countries, BICs. A hit → HOLD (sanctions). No answer → **HOLD** (fail closed). |
| 6 | orchestrator | | load rules (cached), evaluate. e.g. `HIGH_VALUE_HOLD`, `CUT_OFF`, `BLOCKED_CORRIDOR` |
| 7 | orchestrator → SWIFT outbound | `payments.routed.swift.v1` | released instruction, with routing decision |
| 8 | SWIFT outbound → GTX | `payments.outbound.v1` | instruction with next agent, charges and settlement date |
| 9 | GTX → Alliance Access | MQ queue (`saa.outbound`) | outbound `pacs.008`, **same UETR** |
| 10 | Alliance Access → GTX | MQ queue (`saa.notifications`) | ACK (sent) or NAK (rejected by the network) |
| 11 | every service → data ingestion | `payments.lifecycle.v1` | RECEIVED, SCREENED, HELD, RELEASED, SENT, ACKED or NAKED |
| 12 | data ingestion → Spanner, BigQuery | | upsert state; append event |

### 3.2 Held for four-eyes review

Rule `HIGH_VALUE_HOLD` matches → orchestrator publishes `payments.held.v1` and a HELD lifecycle event → payment waits.
One person reviews and proposes release, and a **different** person approves (stretch:
`POST /holds/{uetr}/approve`; the API refuses if the approver is the reviewer) → the payment continues from step 7.

### 3.3 Screening hit

Screening returns a hit → HELD with reason `SANCTIONS_HIT`. It is never released automatically. In a real bank,
compliance reviews it. In the demo, it stays held.

### 3.4 Network rejection

Alliance Access returns a NAK at step 10 → GTX publishes NAKED with the reason → the payment needs repair. The
demo shows the status only.

### 3.5 Recall (stretch)

Once a payment has left, **the bank can only ask for it back.** GTX sends a recall request (gpi Stop and Recall, or
camt.056) → `saa-sim` answers: accepted if not yet credited (a `pacs.004` return follows), declined or "needs
beneficiary consent" if credited. There is no undo.

---

## 4. Contracts

**Kafka topics** (in the demo, Kafka also plays the MQ queues on the Alliance Access side):

| Topic | Producer → consumer | Payload |
|---|---|---|
| `saa.inbound` | saa-sim → GTX | pacs.008 XML |
| `saa.outbound` | GTX → saa-sim | pacs.008 XML |
| `saa.notifications` | saa-sim → GTX | ACK/NAK + delivery notices |
| `payments.inbound.v1` | GTX → orchestrator | `PaymentInstruction` |
| `payments.held.v1` | orchestrator → (workbench) | `PaymentInstruction` + hold reason |
| `payments.routed.swift.v1` | orchestrator → SWIFT outbound | `PaymentInstruction` + routing decision |
| `payments.outbound.v1` | SWIFT outbound → GTX | `OutboundPayment` |
| `payments.lifecycle.v1` | all → data ingestion | `PaymentLifecycleEvent` |
| `*.DLT` | | dead letters, per consumer |

**pacs.008 subset** (CBPR+ elements the demo uses): `GrpHdr/MsgId`, `CreDtTm`, `PmtId/InstrId`, `EndToEndId`,
`UETR`, `IntrBkSttlmAmt@Ccy`, `IntrBkSttlmDt`, `ChrgBr`, `Dbtr/Nm`, `Dbtr/PstlAdr`, `DbtrAcct/IBAN`,
`DbtrAgt/BICFI`, `CdtrAgt/BICFI`, `Cdtr/Nm`, `Cdtr/PstlAdr` (hybrid: `TwnNm`, `Ctry`, up to two `AdrLine`),
`CdtrAcct/IBAN`, `RmtInf/Ustrd`.

**Canonical `PaymentInstruction` v1** (JSON): `uetr`, `endToEndId`, `amount`, `currency`, `settlementDate`,
`chargeBearer`, `debtor{name, iban, address}`, `debtorAgentBic`, `creditor{name, iban, address}`, `creditorAgentBic`,
`remittance`, `receivedAt`.

All schemas live in `northwind-contracts`. Every service names the version it reads and writes.

---

## 5. Data ownership

| Store | Owner (writes) | Readers | Holds |
|---|---|---|---|
| Postgres `gtx` | GTX | GTX | message log: every in/out message, UETR de-duplication, audit |
| Postgres `rules`: schema | inbound orchestrator (Flyway) | orchestrator | `routing_rules(rule_id, rule_type, priority, params jsonb, enabled)` |
| Postgres `rules`: rows | **routing-rules repo** (loader job) | orchestrator | rule thresholds, cut-offs, blocked corridors |
| Cloud Spanner | data ingestion (DDL + writes) | PayQuery | `Payments` (state by UETR), `PaymentEvents` (interleaved timeline) |
| BigQuery | data ingestion (schema + writes) | PayQuery, reporting | `payment_events`, `payments_daily` view |

That split (schema in one repo, rows in another) is deliberate. It's real, and it's where story B1 lives.

---

## 6. Controls built in

- **Only GTX talks to SWIFT.** A single choke point, as in the secure-zone model.
- **UETR de-duplication** in GTX: the same payment can't be processed twice, even if Alliance Access redelivers it.
- **Screening fails closed:** no answer means HOLD, never RELEASE.
- **Rules fail closed:** a hold rule that can't read its threshold holds the payment. (The v1 code in story B1
  deliberately doesn't. That's the bug the incident exposes.)
- **Four-eyes** on high-value releases.
- **Message log** of everything in and out, for audit and investigations.

---

## 7. Where the one-way doors are

| Boundary | One-way door | Demo story |
|---|---|---|
| rules data ⇄ orchestrator code (two repos) | rule parameter renamed and rescaled; the old code skips the hold silently | **B1: "The Rule Nobody Owned"** (main act) |
| GTX ⇄ canonical contract ⇄ consumers | structured address replaces unstructured (CBPR+ deadline 14 November 2026); old readers see blanks | **B2: "The Field Nobody Owned"** (second act) |
| GTX message log | UETR or dedupe-key format change; rollback stops recognising sent payments, so they're sent twice | A: "The Double-Sent Payment" (optional) |
| data ingestion ⇄ Spanner/BigQuery ⇄ PayQuery | column drop or rename; old PayQuery pods mid-rolling-update return blanks or errors | C: "The Mixed Pods" (optional) |
| GTX ⇄ SWIFT | anything sent is out; you can only *request* a recall | the punchline of every story |

---

## 8. Hackathon scope

**MVP (needed for the demo):** saa-sim (inbound, outbound, ACK), GTX (bridge, validation, UETR de-duplication,
message log, canonical transform), orchestrator (screening call, rules, HOLD/RELEASE), routing-rules + loader,
SWIFT outbound, data ingestion → Spanner + BigQuery, PayQuery in compose. Story B1 end to end.

**Stretch, in order:**
1. PayQuery on `kind`, with a real rolling update.
2. Story B2 (structured addresses).
3. Four-eyes approve endpoint.
4. Recall flow (camt.056 → camt.029 / pacs.004).
5. A CHAPS or Faster Payments outbound rail.

---

## 9. Simplifications (say them out loud)

- Alliance Access, the SWIFT network and the other banks are one simulator. Kafka stands in for IBM MQ on that side.
- pacs.008 is a subset with light validation, not full CBPR+ XSD and usage-guideline checks.
- No account posting, nostro/vostro, liquidity or FX. Settlement is out of scope.
- Screening is a list lookup, not fuzzy matching.
- No cover payments (pacs.009 COV). The demo uses the serial method only.
- Spanner and BigQuery are emulators. The BigQuery emulator is a community project with gaps.

---

## 10. Context worth knowing on stage

- MT/ISO 20022 coexistence for cross-border payment instructions ended on **22 November 2025**. MT103s are still
  converted (for a fee from January 2026), but pacs.008 is the native format.
- Under CBPR+, fully unstructured postal addresses are no longer accepted from **November 2026** (bank guidance says
  14 November). The minimum is "hybrid": town and country structured, plus up to two free-text lines. For CHAPS, the
  Bank of England's equivalent rule has reportedly been deferred (check the Bank's ISO 20022 page).
- SWIFT carries messages; it doesn't move money. Settlement happens over correspondent accounts, or over CHAPS and
  Faster Payments in the UK.
- gpi Stop and Recall can ask for a payment back, even after credit, but it is a request. After credit, getting
  the money back needs the beneficiary's consent.

Sources: [SWIFT Alliance Access](https://www.swift.com/products/alliance-access) ·
[Alliance Access MQ Host Adaptor](https://swift.com/swift_resource/12506) ·
[CBPR+ and end of coexistence (Clearstream)](https://www.clearstream.com/clearstream-en/res-library/connectivity/cross-border-payments-and-reporting-cbpr--4446956) ·
[November 2026 CBPR+ address mandate (J.P. Morgan)](https://www.jpmorgan.com/insights/payments/cross-border-payments/iso-20022-migration) ·
[Bank of England: ISO 20022 enhanced data in CHAPS](https://www.bankofengland.co.uk/paper/2024/policy-statement/mandating-iso-20022-enhanced-data-in-chaps) ·
[gpi Stop and Recall (SWIFT developer)](https://community.developer-dev.swift.com/node/6576) ·
[SWIFT Transaction Screening](https://www.swift.com/ru/node/2366)
