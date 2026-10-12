# Northwind Payments: target architecture (hackathon)

A simple, realistic model of how a UK bank receives a SWIFT payment, checks it and sends it on. It is the stage for
the multi-repo One-Way Door demo. **Northwind Payments** and every bank, account and amount in it are invented.

Northwind acts as an **intermediary bank**: it receives an ISO 20022 payment (pacs.008) over SWIFT, checks it, and
forwards it to the next bank with the same tracking number (UETR).

---

## 1. The big picture

```
  SWIFT network ──► Alliance Access ──MQ──► GTX gateway exchange ──► Kafka ──► Inbound orchestrator
  (other banks)     (SWIFT interface)       • validate pacs.008                 • sanctions screening
        ▲                  ▲                • de-duplicate on UETR               • routing rules (Postgres)
        │                  │                • message log (Postgres)             • RELEASE or HOLD
        │                  └──────MQ─────── • format outbound pacs.008                 │ RELEASE
        │                                          ▲                                   ▼
        └──────────────────────────────────────────┴──── Kafka ◄──── SWIFT outbound
                                                                     (next bank, cut-off)

  Every service ──► Kafka (payments.lifecycle) ──► Data ingestion ──► Cloud Spanner (live status)
                                                                   └► BigQuery (history)
```

**One rule:** only GTX talks to SWIFT's interface. No other service has SWIFT access.

---

## 2. Components

| Component | What it does | Demo stand-in | Repo |
|---|---|---|---|
| SWIFT network + Alliance Access | carries messages between banks; the bank's SWIFT interface (MQ queues, ACK/NAK) | `saa-sim` simulator | `northwind-platform` |
| **GTX: Gateway Exchange** | validates messages, blocks duplicates (UETR), logs everything, converts SWIFT format ⇄ internal format | Spring Boot + Postgres `gtx` | `northwind-gtx-gateway` |
| Inbound orchestrator | screens each payment, applies routing rules, releases or holds | Spring Boot | `northwind-inbound-orchestrator` |
| Routing rules | the rule data (thresholds, blocked corridors, cut-offs) | JSON files + loader job into Postgres `rules` | `northwind-routing-rules` |
| Screening | sanctions check; no answer means HOLD | `screening-sim` | `northwind-platform` |
| SWIFT outbound | picks the next bank, checks the cut-off, hands the payment back to GTX | Spring Boot | `northwind-swift-outbound` |
| Data ingestion | writes every status change into Spanner and BigQuery | Spring Boot | `northwind-data-ingestion` |
| Cloud Spanner / BigQuery | live status by UETR / full history | emulators | (data-ingestion owns their schemas) |
| Contracts | message formats shared by all services | JSON Schema | `northwind-contracts` |

---

## 3. The flow

1. Another bank sends a **pacs.008** over SWIFT. It arrives at Alliance Access and goes onto an MQ queue.
2. **GTX** validates it, checks the UETR hasn't been seen before, writes it to the message log, converts it to the
   internal format and puts it on Kafka.
3. The **orchestrator** asks **screening**. A hit, or no answer, means **HOLD**.
4. The orchestrator applies the **routing rules** from Postgres. For example, a payment above the threshold is **HELD** for
   approval. Otherwise it is **RELEASED**.
5. **SWIFT outbound** picks the next bank, checks today's cut-off, and passes the payment back to GTX.
6. **GTX** formats the outbound pacs.008 (same UETR) and sends it through Alliance Access.
7. SWIFT answers **ACK** (accepted by the network) or **NAK** (rejected).
8. At every step, services publish a status (RECEIVED, SCREENED, HELD, RELEASED, SENT, ACKED or NAKED).
   **Data ingestion** writes it to **Spanner** (live status) and **BigQuery** (history). In the demo, `status.sh`
   reads both.

Once a payment has left, the bank can only *request* it back (gpi Stop and Recall). After the money is credited,
that needs the recipient's agreement.

---

## 4. Kafka topics

| Topic | From → to |
|---|---|
| `saa.inbound` / `saa.outbound` / `saa.notifications` | saa-sim ⇄ GTX (these stand in for the MQ queues) |
| `payments.inbound.v1` | GTX → orchestrator |
| `payments.routed.swift.v1` | orchestrator → SWIFT outbound |
| `payments.outbound.v1` | SWIFT outbound → GTX |
| `payments.held.v1` | orchestrator → (held payments) |
| `payments.lifecycle.v1` | all → data ingestion |

---

## 5. Who owns which data

| Store | Written by | Read by |
|---|---|---|
| Postgres `gtx` (message log) | GTX | GTX |
| Postgres `rules`: **table schema** | orchestrator repo (Flyway) | orchestrator |
| Postgres `rules`: **rule rows** | **routing-rules repo** (loader job) | orchestrator |
| Spanner, BigQuery | data ingestion | `status.sh`, reports |

The rules split (schema in one repo, rows in another) is deliberate. It's common in practice, and it's where the main
demo story lives.

---

## 6. Controls

- Only GTX talks to SWIFT.
- UETR de-duplication: no payment is processed twice.
- Screening fails closed.
- Rules fail closed: a hold rule that can't read its threshold should hold. The old code in story B1 doesn't, and
  that's the bug.
- Everything in and out is logged.

---

## 7. Where the one-way doors are

| Boundary | One-way door | Demo story |
|---|---|---|
| rule data (one repo) ⇄ orchestrator code (another repo) | rule parameter renamed and moved to pence; rolled-back code silently skips the hold | **B1: "The Rule Nobody Owned"** (main act) |
| message format ⇄ every reader | structured address replaces free-text lines (CBPR+, November 2026); old readers see blanks | **B2: "The Field Nobody Owned"** (second act) |
| GTX message log | UETR or dedupe-key format change; rollback sends payments twice | A: "The Double-Sent Payment" (optional) |
| GTX ⇄ SWIFT | anything sent is out; you can only request a recall | the punchline of every story |

---

## 8. Hackathon scope

**MVP:** saa-sim, GTX, orchestrator + screening-sim, routing-rules + loader, SWIFT outbound, data ingestion into
Spanner and BigQuery, and `status.sh`. Story B1 end to end.

**Stretch:** story B2, then an approve endpoint for held payments, then the recall flow.

---

## 9. Simplifications (say them on stage)

- One simulator plays SWIFT, Alliance Access and the other banks. Kafka stands in for the MQ queues.
- pacs.008 is a subset with light validation.
- No account posting, funds checks, fees or settlement.
- Screening is a list lookup.
- Spanner and BigQuery are emulators.

---

## 10. Context

- MT payment instructions ended on 22 November 2025. pacs.008 is the native format.
- Under CBPR+, fully unstructured addresses stop being accepted in **November 2026** (bank guidance: 14 November).
  The minimum is town and country as structured fields.
- SWIFT moves messages, not money. Settlement happens between banks' accounts.

Sources: [SWIFT Alliance Access](https://www.swift.com/products/alliance-access) ·
[Alliance Access MQ Host Adaptor](https://swift.com/swift_resource/12506) ·
[CBPR+ and end of coexistence (Clearstream)](https://www.clearstream.com/clearstream-en/res-library/connectivity/cross-border-payments-and-reporting-cbpr--4446956) ·
[November 2026 address mandate (J.P. Morgan)](https://www.jpmorgan.com/insights/payments/cross-border-payments/iso-20022-migration) ·
[gpi Stop and Recall (SWIFT developer)](https://community.developer-dev.swift.com/node/6576)
