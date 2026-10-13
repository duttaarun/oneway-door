# One-way patterns

A change is a **one-way door** when it leaves behind state that the previous version of the code can't handle.
Rolling back the code doesn't roll back that state, so rollback stops restoring service and often makes things worse.

Every pattern below has the same five parts:

- **Spot it**: what it looks like in a diff.
- **Door closes**: the moment after which rollback is no longer safe.
- **If rolled back**: what happens when the old code meets the new state.
- **Safe split**: how to make the same change in steps that can each be rolled back.
- **Default severity**: `high` means rollback breaks or data is lost. `medium` means it breaks under some deploy orders or
  configurations, so check. `low` means it is usually fine, but say so.

The id in each heading (for example `column-rename`) is the `pattern` value the scripts print.
Use the same id in the PR comment.

Contents:
[Data](#data) · [Messages](#messages) · [State](#state) · [External](#external) ·
[The general split](#the-general-split-expand--migrate--contract--drop) · [Worked example: PR #482](#worked-example-pr-482)

---

## Data

Database migrations close the door **when they run**. With Flyway, Liquibase or EF Core run on start-up, that is
the moment the new version boots, usually before it takes any traffic. The safe rollback window is therefore zero
unless the old code can work with the new schema.

### `column-rename`

- **Spot it:** `ALTER TABLE t RENAME COLUMN a TO b` (or Postgres `RENAME a TO b`), MySQL `CHANGE COLUMN a b …`,
  SQL Server `sp_rename 't.a', 'b', 'COLUMN'`, Liquibase `renameColumn`, EF Core `migrationBuilder.RenameColumn`.
  Often paired with an entity change such as `@Column(name = "b")`.
- **Door closes:** when the migration runs.
- **If rolled back:** old code asks for `a`. Raw SQL fails with `column "a" does not exist`. An ORM that validates
  the schema (Hibernate `ddl-auto=validate`, EF model checks) refuses to start. Other readers of `a`, such as reports,
  batch jobs, BI and other services, break **straight away, even without a rollback**.
- **Safe split:** add `b` → write both → backfill `b` from `a` and check they agree → move every reader to `b` →
  stop writing `a` (keep it filled for older readers if needed) → drop `a`. A view with the old name can carry
  legacy readers in the meantime.
- **Default severity:** high.

### `table-rename`

- **Spot it:** `ALTER TABLE a RENAME TO b`, `RENAME TABLE a TO b`, `sp_rename 'a', 'b'`, Liquibase `renameTable`,
  EF Core `RenameTable`.
- **Door closes:** when the migration runs.
- **If rolled back:** every query from the old code fails (`relation "a" does not exist`), and the ORM won't start.
- **Safe split:** create `b` and write to both, or rename and add a view or synonym called `a`. Move readers. Drop the
  view in a later release.
- **Default severity:** high.

### `column-drop`

- **Spot it:** `ALTER TABLE t DROP COLUMN c`, Liquibase `dropColumn`, EF Core `DropColumn`, a field removed from
  an entity alongside a migration.
- **Door closes:** when the migration runs. The data is gone unless you restore a backup.
- **If rolled back:** old code that selects or inserts `c` fails, and validating ORMs won't start. Even when the
  column comes back, its values don't.
- **Safe split:** stop reading `c` → stop writing it (make it nullable or give it a default) → release, and wait until
  no version in the rollback window references it → drop. Copy the data first if anyone could want it.
- **Default severity:** high. It drops to low only when you have checked that **no code at base or head** reads or
  writes the column and the data is redundant, for example the final step of a split.

### `table-drop`

- **Spot it:** `DROP TABLE`, Liquibase `dropTable`, EF Core `DropTable`.
- **Door closes:** when the migration runs.
- **If rolled back:** old code fails on every query against the table. The rows are lost.
- **Safe split:** the same as `column-drop`. Rename to `t_retired` first if you want a cheap undo.
- **Default severity:** high.

### `column-retype`

- **Spot it:** `ALTER TABLE t ALTER COLUMN c TYPE x` (Postgres), `MODIFY COLUMN c x` (MySQL),
  `ALTER COLUMN c x` (SQL Server), Liquibase `modifyDataType`, EF Core `AlterColumn<T>` with a different type.
- **Door closes:** when the migration runs.
- **If rolled back:** validating ORMs refuse to start (`wrong column type`). Non-validating code reads the new type
  with the old meaning. With a unit change such as pounds to pence, every value is out by 100 and **nothing errors**.
  Narrowing (`numeric`→`int`, `varchar(100)`→`varchar(20)`, `timestamptz`→`timestamp`) loses data on the way.
- **Safe split:** add a new column of the new type, dual-write, backfill, move readers, then drop the old column.
- **Default severity:** high.

### `in-place-conversion`

- **Spot it:** `UPDATE t SET c = <expression using c>` in a migration (`c * 100`, `lower(c)`, `c AT TIME ZONE …`,
  `md5(c)`), or `ALTER … TYPE … USING (<expression>)` that does more than cast. Liquibase `update`, or EF `Sql("UPDATE …")`.
- **Door closes:** when the statement commits.
- **If rolled back:** old code reads converted values with the old meaning. It is silently wrong, not broken. If the
  conversion can't be reversed (rounding, truncation, hashing, lower-casing, dropping a time zone), a reverse
  migration can't restore the original values. That is **information loss**.
- **Safe split:** never convert in place. Write the converted value to a new column (see `backfill`), keep the
  original until the drop step, and check the two agree before anyone relies on the new one.
- **Default severity:** high.

### `not-null`

- **Spot it:** `ALTER COLUMN c SET NOT NULL`, `ADD COLUMN c … NOT NULL` with no `DEFAULT`, Liquibase
  `addNotNullConstraint`, EF Core `AlterColumn(nullable: false, oldNullable: true)`.
- **Door closes:** when the constraint is added.
- **If rolled back:** old code that doesn't write `c` fails on insert (`null value in column "c" violates not-null
  constraint`). Requests return 500 and consumers dead-letter messages. The same happens during a rolling deploy
  while old instances are still running.
- **Safe split:** add `c` as nullable → ship code that always writes it → backfill → add `NOT NULL` only when every
  version in the rollback window writes `c`. `ADD COLUMN … NOT NULL DEFAULT x` is rollback-safe if `x` is a
  correct value for old rows and for rows the old code will insert.
- **Default severity:** high for `ADD COLUMN … NOT NULL` with no default. Medium for `SET NOT NULL`: it is safe when the
  previous version already writes the column, so check.

### `backfill`

- **Spot it:** `UPDATE t SET new_col = f(old_col) WHERE new_col IS NULL`. It fills a column **other than the one it
  reads**.
- **Door closes:** usually never. The original column is untouched.
- **If rolled back:** fine if the old code ignores `new_col`. Rows the old code writes after a rollback won't have
  `new_col`, so make the backfill re-runnable, or have the previous version write both columns.
- **Safe split:** this *is* the safe step. Check it is idempotent, batched for large tables (lock time), and
  followed by a check that old and new agree.
- **Default severity:** low.

### `row-delete`

- **Spot it:** `DELETE FROM` or `TRUNCATE` in a migration, or Liquibase `delete`.
- **Door closes:** when the statement commits.
- **If rolled back:** old code finds the rows missing. The data is gone.
- **Safe split:** soft-delete, or copy the rows to an archive table first. Delete them in a later release.
- **Default severity:** high.

### `applied-migration-edited`

- **Spot it:** a migration file that **already exists on the base branch** is modified. Flyway `V…__*.sql`,
  Liquibase changesets without `runOnChange`, and EF Core migration classes are all immutable once applied.
  Flyway repeatable migrations (`R__*.sql`) are the exception.
- **Door closes:** it already closed. Every environment that ran the old content keeps the old content.
- **If rolled back:** environments drift apart. Flyway fails start-up with a checksum mismatch. That is good, unless
  someone runs `flyway repair` and hides it. Liquibase throws a checksum error. EF silently ignores the change. New
  environments get the new content and existing ones keep the old.
- **Safe split:** never edit. Put the change in a new migration.
- **Default severity:** high.

---

## Messages

Event changes close the door **when the first new-format message is published**. Rolling back the producer doesn't
delete messages from the topic. They stay for the topic's retention period, and any consumer reading them later
(after a restart, a rollback or a replay) gets the new format. Rolling back a consumer while there is a backlog is
the worst case: old code meets new messages at full speed.

Check both directions:

- **Old reader, new events:** a consumer rolled back (or not yet upgraded) reads what the new producer wrote.
- **New reader, old events:** a new consumer reads the backlog from before the deploy, or events from a producer
  that was rolled back.

### `event-field-removed`

- **Spot it:** a property removed from a JSON Schema, Avro or Protobuf contract, or from the producer's DTO.
  Also a field dropped from `required`, or an `@JsonIgnore` added.
- **Door closes:** when the first event without the field is published.
- **If rolled back:** consumers that still read the field get `null`, an exception, or a silent default (see
  `missing-primitive-default`). Rolling back the producer doesn't fix events already on the topic.
- **Safe split:** consumers stop reading the field first (consumer first). The producer keeps sending it. Remove it
  from the producer only when no consumer in the rollback window reads it.
- **Default severity:** high if the field was required. Low if it was always optional and consumers handle its absence.

### `event-field-made-optional`

- **Spot it:** a property stays in the schema but leaves `required`, or becomes nullable.
- **Door closes:** when a producer first leaves it out. Until then, nothing changes on the wire.
- **If rolled back:** old consumers that assume the field is always there get `null` or a silent default, the same
  as `event-field-removed`.
- **Safe split:** this is the normal contract step. It is safe while every producer in the rollback window still
  sends the field. Check that.
- **Default severity:** medium.

### `event-schema-deleted`

- **Spot it:** a whole event schema file is deleted, or an event type stops being produced.
- **Door closes:** when the last producer of that event is gone.
- **If rolled back:** usually harmless for consumers, which just stop receiving it. Check for consumers that alert,
  or that wait on the event to finish a workflow.
- **Safe split:** stop producing first. Delete the contract after every consumer has been removed.
- **Default severity:** medium.

### `event-field-renamed`

- **Spot it:** a property removed and another added in the same change, usually with similar names
  (`amount` → `amountMinor`).
- **Door closes:** when the first event with the new name is published.
- **If rolled back:** to an old consumer, the field has simply vanished, and the new one is an unknown property it
  ignores. You get the same failure as `event-field-removed`, with nothing in the logs.
- **Safe split:** the producer sends both names. Consumers prefer the new one and fall back to the old. The producer
  stops sending the old one in a later release.
- **Default severity:** high.

### `event-field-retyped`

- **Spot it:** a property's `type` changes (`number` → `string`, `integer` → `number`), its `format` changes, or its
  **meaning** changes while the type stays the same (pounds → pence, seconds → milliseconds, UTC → local).
  Schema tools can't see a unit change. Read the descriptions and the code.
- **Door closes:** when the first new-format event is published.
- **If rolled back:** a different JSON type usually fails deserialisation, so the message lands in the dead-letter
  topic. That is loud and recoverable. The same type with a new meaning is silent, and the wrong value gets stored.
- **Safe split:** add a new field with the new type or unit. Never reuse the old field.
- **Default severity:** high.

### `event-enum-value-added`

- **Spot it:** a new value in an `enum`, or a new event subtype or discriminator value.
- **Door closes:** when the first event with the new value is published.
- **If rolled back:** Jackson fails on unknown enum constants by default (`READ_UNKNOWN_ENUM_VALUES_AS_NULL` is off),
  so the message goes to the DLT. `switch` statements fall into a default branch that may do the wrong thing.
- **Safe split:** ship consumers that tolerate unknown values first (`@JsonEnumDefaultValue`, explicit default
  branch). Start emitting the new value in a later release.
- **Default severity:** medium.

### `event-required-field-added`

- **Spot it:** a new property that is also in `required`, or a new non-optional field in the producer's DTO.
- **Door closes:** when consumers that need the field are deployed.
- **If rolled back:** new consumers reading old events (the backlog, a replay, or a producer that was rolled back)
  find the field missing. They get `null`, `0` or an exception. Old producers still running mid-deploy send events
  without it.
- **Safe split:** add the field as optional. Consumers must cope without it. Make it required only after every
  producer sends it and old events have aged out of the topic.
- **Default severity:** high when consumers depend on the value. Medium otherwise.

### `strict-consumer-new-field`

- **Spot it:** any new property, when some consumer is strict: Jackson `FAIL_ON_UNKNOWN_PROPERTIES=true`,
  `additionalProperties: false` validation, .NET `JsonUnmappedMemberHandling.Disallow`, an Avro reader schema
  without a default.
- **Door closes:** when the first event with the new field is published.
- **If rolled back:** the strict consumer rejects every new event, so they all land in the dead-letter topic or the
  consumer crash-loops. Rolling back the producer stops new ones, but those already published keep failing.
- **Safe split:** make consumers lenient first. Then add the field.
- **Default severity:** high if a strict consumer exists. Low otherwise. Search for it before deciding.

### `missing-primitive-default`

- **Spot it:** a numeric or boolean field is removed or renamed (or is new and required), and a consumer binds it
  to a primitive: Java `double`/`long`/`int`/`boolean`, C# non-nullable value types, Go `float64`/`int`/`bool`,
  Kotlin non-null with a default. Jackson's `FAIL_ON_NULL_FOR_PRIMITIVES` and `FAIL_ON_MISSING_CREATOR_PROPERTIES`
  are off by default.
- **Door closes:** when the first event without the field reaches that consumer.
- **If rolled back:** the consumer reads `0`, `0.0` or `false` and carries on. There is no exception and nothing in
  the dead-letter topic, and the wrong value is stored. This is the £0.00 settlement.
- **Safe split:** consumers bind to nullable types (`Double`, `Long`, `decimal?`, `*float64`) and reject a missing
  required value loudly, which sends it to the DLT. Or turn on `FAIL_ON_NULL_FOR_PRIMITIVES` and
  `FAIL_ON_MISSING_CREATOR_PROPERTIES`. Then follow the `event-field-renamed` split.
- **Default severity:** high.

---

## State

The scripts don't detect these. Read the diff for them.

### `cache-format-change`

- **Spot it:** changes to classes stored in Redis or Memcached, distributed sessions or a disk cache. Changes to
  `@Cacheable` return types, cache serialiser configuration (JDK → JSON, compression on), or the cache key
  scheme. Java `Serializable` classes with a changed `serialVersionUID` or new fields.
- **Door closes:** on the first write in the new format. It stays open as long as the TTL.
- **If rolled back:** old code reads new-format entries and gets deserialisation errors (500s, or a cache-miss storm
  if errors are swallowed) or wrong values. The reverse also happens: new code reads old entries after a roll forward.
- **Safe split:** version the cache key (`v2:payment:123`) so the two formats never share entries. Or make readers
  accept both formats first. Remove the old reader after one TTL.
- **Default severity:** medium. High if errors aren't caught or the TTL is long.

### `idempotency-key-format-change`

- **Spot it:** changes to how idempotency keys, dedupe keys, outbox message ids, or request hashes are built
  (`paymentId` → `paymentId:attempt`, a new hash, a new prefix). Look in idempotency filters, outbox writers and
  "already processed" checks.
- **Door closes:** on the first key stored in the new format.
- **If rolled back:** old code looks for old-format keys, misses the new ones, and **processes the request again**:
  a double charge or a double booking. Retries that straddle the deploy have the same problem going forward.
- **Safe split:** check both formats when reading, for at least the dedupe window, while still writing the old
  format. Then switch writing to the new format. Then drop the old check.
- **Default severity:** high.

---

## External

The door closes as soon as someone outside your deploy pipeline sees the change. You can't roll back a partner.

### `servicebus-entity-deleted`

- **Spot it:** IaC removes an Azure Service Bus queue, topic, subscription or rule
  (`Microsoft.ServiceBus/namespaces/topics/subscriptions` in Bicep or ARM, `azurerm_servicebus_*` in Terraform).
  The same applies to Kafka topics, SQS queues, SNS subscriptions and RabbitMQ queues.
- **Door closes:** when the IaC is applied. Messages in the entity, and its dead-letter queue, are deleted.
- **If rolled back:** re-creating the entity doesn't bring the messages back. Old code that sends or receives gets
  `MessagingEntityNotFound` until the entity exists again.
- **Safe split:** stop producers → drain → leave the empty entity for a release → delete it in a separate change.
- **Default severity:** high.

### `apim-version-removed`

- **Spot it:** IaC or OpenAPI changes that remove an Azure API Management API version, revision or operation, or
  make a different revision current (`Microsoft.ApiManagement/service/apis`, `azurerm_api_management_api*`).
  The same applies to removed paths in any public API spec.
- **Door closes:** when it is published. External clients start getting 404s straight away.
- **If rolled back:** you can republish, but clients that failed in the meantime have already failed, and any that
  migrated may now be calling a version you've restored by accident.
- **Safe split:** mark it deprecated (`Deprecation` and `Sunset` headers) → watch usage fall to zero → remove it
  in a later change.
- **Default severity:** high.

### `webhook-payload-change`

- **Spot it:** changes to outbound webhook or callback DTOs, to payloads sent to partners, to the signature or
  signing scheme, or to the event names in webhooks.
- **Door closes:** with the first webhook sent. Partners store and act on it, and you can't recall it.
- **If rolled back:** you can't unsend it. Partners that adapted to the new format break again when you roll back.
- **Safe split:** version the payload (a header or the URL). Send the new version only to partners that opt in.
  Never change a published version in place.
- **Default severity:** high.

---

## The general split: expand → migrate → contract → drop

Each step must pass one rule: **the previous version's code runs correctly against this version's state.** That
includes every combination a rolling deploy creates, such as a new producer with an old consumer.

| Step | Database | Events | Code |
|---|---|---|---|
| 1. Expand | Add the new column, nullable | Add the new field, optional | Writers write both. Readers prefer the new value and fall back to the old. |
| 2. Migrate | Backfill old rows; check old and new agree | (nothing) | Nothing reads the new column alone yet |
| 3. Contract | Make the new column `NOT NULL`. Keep the old one filled for the previous release (for example a trigger) | Old field no longer required | Readers use only the new value. The app stops writing the old one. |
| 4. Drop | Drop the old column and its trigger | Stop sending the old field | Nothing at this version or the previous one touches it |

You can roll each step back to the one before it. The drop step deletes data that is now redundant: check it is
redundant before you merge.

---

## Worked example: PR #482

PR #482 ("store settlement amounts in minor units") changes three things at once.

1. `V3__amount_minor_units.sql`:
   ```sql
   ALTER TABLE ledger_entries RENAME COLUMN amount TO amount_minor;
   ALTER TABLE ledger_entries ALTER COLUMN amount_minor TYPE bigint USING (amount_minor * 100)::bigint;
   ```
   That is `column-rename`, `column-retype` and `in-place-conversion`. The door closes when ledger-service starts.
2. `PaymentSettled` drops `double amount` and gains `long amountMinor`, and the schema matches. That is
   `event-field-removed`, `event-required-field-added` and `event-field-renamed`. The door closes with the first v2 event.
3. ledger-service v1 binds `amount` to a primitive `double` and Spring Kafka ignores unknown properties. That is
   `missing-primitive-default`.

**Blast radius:** `reconciliation-batch` runs `SELECT SUM(amount) FROM ledger_entries` and isn't in the PR. It breaks as
soon as V3 runs, with no rollback needed.

**What happened when it was rolled back.** ledger-service v1 refused to start
(`Schema-validation: missing column [amount]`). A hand-written hotfix reversed V3 and v1 started. Then v1
consumed the backlog of v2 events and booked every one at £0.00. There was no error and nothing in the DLT.

**The split** (branches `split/1-expand` … `split/4-drop`) reaches the same end state, and each step rolls back cleanly:

| PR | Database | Event | Code |
|---|---|---|---|
| 1 expand | `V3`: add `amount_minor bigint` (nullable) | add optional `amountMinor` | settlement sends both. ledger writes both columns, preferring `amountMinor`. |
| 2 migrate | `V4`: backfill `amount_minor`, fail if any row disagrees | (none) | reconciliation also reports rows where the columns disagree |
| 3 contract | `V5`: `amount_minor` NOT NULL. `amount` nullable and filled by a trigger | `amount` no longer required | ledger stops reading and writing `amount` and rejects events without `amountMinor`. reconciliation sums `amount_minor`. |
| 4 drop | `V6`: drop the trigger and `amount` | remove `amount` | settlement stops sending `amount` |

`demo/scripts/rollback-test.sh` proves it. It deploys each step, sends traffic, rolls back, and sends traffic again.
Every step passes, and PR #482 fails.
