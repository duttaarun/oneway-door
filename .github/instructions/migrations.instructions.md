---
applyTo: "**/db/migration/**,**/db/changelog/**,**/migrations/**,**/Migrations/**,**/liquibase/**,contracts/events/**"
---

# Database migrations and event contracts

Changes in these folders can be **one-way doors**. Once deployed, they leave state behind (a migrated table, events
on a topic) that the previous release can't handle. A rollback then doesn't restore service.

## Rules

- **Change in steps: expand → migrate → contract → drop.** Each step must still work with the code from the step
  before it. That code is what runs if this deploy is rolled back.
  1. Expand: add the new column or field alongside the old one, nullable or optional. Write both.
  2. Migrate: backfill old rows, then check old and new agree.
  3. Contract: move readers to the new column or field. Keep the old one filled for the previous release.
  4. Drop: remove the old one once no release in the rollback window touches it.
- **Never rename, drop or retype a column in one step.** Never convert values in place
  (`UPDATE t SET c = c * 100`, `ALTER … TYPE … USING (expression)`). Write the converted value to a new column.
- **Never edit or delete a migration that is already on the default branch.** Environments that ran it will never
  run your edit. Add a new migration instead. A hook blocks agent edits to applied Flyway and EF Core migrations.
- **Add `NOT NULL` only when every release in the rollback window writes the column.** Otherwise add the column as
  nullable, or give it a correct default.
- **Event fields:** add new fields as optional. Consumers move first, and producers stop sending a field last. Never
  remove, rename or retype a field that a consumer still reads. Never reuse a field with a new meaning or unit.
- **Consumers:** bind numbers and booleans to nullable types (`Long`, `Double`, `decimal?`). Reject a missing
  required value loudly so it goes to the dead-letter topic. Never let it default to `0` or `false`.

## Before you finish

Before finishing any change here, run the **one-way-door** skill (`.github/skills/one-way-door/SKILL.md`)
against the default branch. Include its verdict line in your summary or PR description. If the verdict is ONE-WAY,
propose the split it suggests instead of the change as written.
