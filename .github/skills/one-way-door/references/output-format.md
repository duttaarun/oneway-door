# PR comment format

Write the review as one Markdown comment in exactly this shape. Use British English and short sentences. Don't
use hype words, and don't use emoji. Say what breaks; don't say "might potentially".

## Template

```markdown
## One-way door check

**Verdict: <ONE-WAY | TWO-WAY>** · Safe rollback window: **<window>**

<One or two sentences: what the PR changes and why it is or isn't safe to roll back.>

### Findings

1. **<Short title>** · `<object>` · `<file>:<line>` · `<pattern-id>`
   - **Door closes:** <the moment, in deploy terms>
   - **If rolled back:** <what the previous version does against the new state; quote the real error if there is one>
   - **Data loss:** <none | what is lost, and whether it can be recovered>

2. …

### Blast radius

| Reader | Where | Uses | Breaks when |
|---|---|---|---|
| <service or job> | `<file>:<line>` | `<what it reads>` | <moment> |

### Suggested split

| PR | Change | Rolls back to the previous PR? |
|---|---|---|
| 1. Expand | … | Yes: <why> |
| 2. Migrate | … | Yes: <why> |
| 3. Contract | … | Yes: <why> |
| 4. Drop | … | Yes: <why> |

I can generate this split as branches `split/1-expand` to `split/4-drop` (and open PRs if you want). Reply "generate the split".

<sub>one-way-door · scan-migrations: <n> findings · schema-compat: <n> findings · checked <base>...<head></sub>
```

## Rules

**Verdict line**
- `ONE-WAY` if any finding means the previous version breaks, misbehaves or loses data after this PR is deployed.
  Otherwise `TWO-WAY`.
- The safe rollback window is the time after deploy during which rolling back is still safe. Use one of these:
  - `none`, with the reason in brackets, for example `none (closes when V42 runs at ledger-service start-up)`.
  - `until <event>`, for example `until the first v2 event is published`. Use this when deploy order or a feature
    flag holds the door open.
  - `unlimited` for TWO-WAY.

**Findings**
- Number them, most severe first. Merge script findings about the same object into one finding, and list every
  pattern id it covers, for example `column-rename, column-retype, in-place-conversion`.
- `Door closes` names a deploy moment: "when ledger-service starts and Flyway runs V42", or "when settlement-service
  publishes its first v2 event". Avoid vague timings like "on deploy".
- `If rolled back` describes old code against new state. Quote the real error message when you know it. If nothing
  errors, say **silently** and say what is wrong.
- `Data loss` says `none`, or what is lost. Mention retention or TTL when the bad state expires on its own.
- Drop script findings you have judged harmless, but mention them in one line under the list, for example:
  "Not a door: `backfill` in V43 only fills the new column."

**Blast radius**
- List every reader of each touched table, column, topic or event field that you found **outside the PR's own
  changes**, including readers the PR updated and readers it didn't. Mark readers the PR didn't touch with **not in
  this PR**. Those are the ones that break first.
- If you searched and found none, write "No other readers found" and the search terms you used.

**Suggested split**
- Only for ONE-WAY. Use the expand → migrate → contract → drop shape from `patterns.md`, adjusted to the change.
  Fewer steps are fine when a step would be empty.
- The last column must justify why each step rolls back to the one before it.
- Always end with the offer to generate it. Don't create branches or PRs unless asked.

**TWO-WAY comments** keep the verdict line and the summary sentence. Add a `### Checked` list naming the buckets
and scripts that came back clean, plus any low-severity notes. Leave out Blast radius and Suggested split.

---

## Worked example (PR #482, `main...pr-482-minor-units`)

```markdown
## One-way door check

**Verdict: ONE-WAY** · Safe rollback window: **none** (closes when V42 runs at ledger-service start-up)

PR #482 renames and converts `ledger_entries.amount` in place and replaces `amount` with `amountMinor` in the
`PaymentSettled` event. After it deploys, the previous ledger-service can't start, and once the schema is patched
it books every new event at £0.00.

### Findings

1. **Column renamed and converted to pence in place** · `ledger_entries.amount` → `amount_minor` · `demo/ledger-service/src/main/resources/db/migration/V42__amount_minor_units.sql:3` · `column-rename, column-retype, in-place-conversion`
   - **Door closes:** when ledger-service starts and Flyway runs V42, before it takes traffic.
   - **If rolled back:** v1 ledger-service fails start-up: `Schema-validation: missing column [amount] in table [ledger_entries]`. Flyway has no undo, so a hand-written reverse is the only way back.
   - **Data loss:** none if the reverse divides by exactly 100. Any reverse that rounds differently corrupts history.

2. **Event field `amount` replaced by `amountMinor`** · `PaymentSettled.amount` · `contracts/events/payment-settled.schema.json:23` · `event-field-removed, event-required-field-added, event-field-renamed`
   - **Door closes:** when settlement-service publishes its first v2 event. Rolling it back doesn't remove events already on `payments.settled`.
   - **If rolled back:** a v1 consumer sees `amount` missing and ignores the unknown `amountMinor`. A v2 consumer reading the v1 backlog sees `amountMinor` missing.
   - **Data loss:** see finding 3.

3. **Missing amount silently becomes £0.00** · `PaymentSettled.amount` (ledger-service, `double amount`) · `demo/ledger-service/src/main/java/com/northwind/ledger/PaymentSettled.java:16` · `missing-primitive-default`
   - **Door closes:** when the first v2 event reaches a v1 ledger-service.
   - **If rolled back:** v1 binds the missing `amount` to `0.0` and books the settlement at **£0.00, silently**. No exception, nothing in `payments.settled.DLT`.
   - **Data loss:** the real amount survives only in the v2 events, until topic retention removes them.

### Blast radius

| Reader | Where | Uses | Breaks when |
|---|---|---|---|
| reconciliation-batch (**not in this PR**) | `demo/reconciliation-batch/src/main/java/com/northwind/reconciliation/Reconcile.java:20` | `SELECT SUM(amount) FROM ledger_entries` | V42 runs: `column "amount" does not exist` |
| ledger-service | `demo/ledger-service/.../LedgerEntry.java` | `ledger_entries.amount` / `amount_minor` | rollback (finding 1) |
| ledger-service consumer | `demo/ledger-service/.../PaymentSettled.java` | `PaymentSettled.amount` | rollback with a v2 backlog (finding 3) |

### Suggested split

| PR | Change | Rolls back to the previous PR? |
|---|---|---|
| 1. Expand | Add nullable `amount_minor`. Add optional `amountMinor` to the event. settlement sends both. ledger writes both, preferring `amountMinor`. | Yes: v1 ignores the extra column and the unknown field, and `amount` is still sent and written. |
| 2. Migrate | Backfill `amount_minor` from `amount` and fail if any row disagrees. reconciliation reports disagreements. | Yes: PR 1 already writes both columns. |
| 3. Contract | `amount_minor` NOT NULL. `amount` nullable and filled by a trigger. ledger reads and writes only `amountMinor`. reconciliation sums `amount_minor`. | Yes: the trigger keeps `amount` correct for PR 2's ledger and reconciliation. settlement still sends `amount`. |
| 4. Drop | Drop the trigger and `amount`. Remove `amount` from the event and stop sending it. | Yes: PR 3 code never touches `amount`. |

I can generate this split as branches `split/1-expand` to `split/4-drop` (and open PRs if you want). Reply "generate the split".

<sub>one-way-door · scan-migrations: 3 findings · schema-compat: 5 findings · checked main...pr-482-minor-units</sub>
```

## Worked example: a TWO-WAY result (`split/2-migrate...split/3-contract`)

```markdown
## One-way door check

**Verdict: TWO-WAY** · Safe rollback window: **unlimited**

This PR moves every reader to `amount_minor` and keeps `amount` filled by a trigger. The previous release still
reads and writes `amount`, so rolling back is safe.

### Checked

- Data: V44 sets `amount_minor` NOT NULL. PR 2's ledger-service already writes it on every insert. `amount` stays and is filled by the trigger.
- Messages: `amount` is no longer required, but settlement-service still sends it. PR 2's consumer prefers `amountMinor`.
- Blast radius: reconciliation-batch moves to `amount_minor` in this PR. No other readers of `ledger_entries.amount`.
- Not a door: `not-null` on `amount_minor` (the previous version writes it), and `event-field-made-optional` on `amount` (still sent).

<sub>one-way-door · scan-migrations: 1 finding · schema-compat: 1 finding · checked split/2-migrate...split/3-contract</sub>
```
