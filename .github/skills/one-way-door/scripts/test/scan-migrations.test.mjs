import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { find, found, makeRepo, run, scan } from './helpers.mjs';
import { splitSql } from '../scan-migrations.mjs';

const MIG = 'svc/src/main/resources/db/migration';
const V1 = `CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  amount numeric(12,2) NOT NULL,
  note text
);
`;

const repos = [];
const repo = (files) => { const r = makeRepo(files); repos.push(r); return r; };
after(() => repos.forEach((r) => r.cleanup()));

describe('scan-migrations: Flyway SQL', () => {
  test('PR #482: rename, retype and in-place conversion in V42', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V42__amount_minor_units.sql`]: `-- Store money as integer minor units.
-- A comment that says DROP COLUMN amount must not count.
ALTER TABLE ledger_entries RENAME COLUMN amount TO amount_minor;
ALTER TABLE ledger_entries ALTER COLUMN amount_minor TYPE bigint USING (amount_minor * 100)::bigint;
`,
    }).commit();

    const { status, json } = scan(r);
    assert.equal(status, 0);
    assert.deepEqual(json.errors, []);
    assert.deepEqual(found(json), [
      'column-rename ledger_entries.amount',
      'column-retype ledger_entries.amount_minor',
      'in-place-conversion ledger_entries.amount_minor',
    ]);
    assert.equal(find(json, 'column-rename').line, 3);
    assert.equal(find(json, 'column-retype').line, 4);
    assert.equal(find(json, 'column-rename').severity, 'high');
    assert.match(find(json, 'in-place-conversion').detail, /amount_minor \* 100/);
    assert.deepEqual(json.migrations.map((m) => [m.kind, m.version, m.status]), [['flyway', '42', 'A']]);
  });

  test('drops: column and table, but not constraints or defaults', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V2__cleanup.sql`]: `ALTER TABLE ledger_entries DROP COLUMN IF EXISTS note, DROP CONSTRAINT ledger_pk;
ALTER TABLE ledger_entries ALTER COLUMN amount DROP DEFAULT;
ALTER TABLE ledger_entries ALTER COLUMN amount DROP NOT NULL;
DROP TABLE IF EXISTS legacy_entries, "Old Audit" CASCADE;`,
    }).commit();

    assert.deepEqual(found(scan(r).json), [
      'column-drop ledger_entries.note',
      'table-drop Old Audit',
      'table-drop legacy_entries',
    ]);
  });

  test('NOT NULL: added without default is high, SET NOT NULL is medium, with default is fine', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V2__nn.sql`]: `ALTER TABLE ledger_entries ADD COLUMN currency varchar(3) NOT NULL;
ALTER TABLE ledger_entries ADD COLUMN status text NOT NULL DEFAULT 'BOOKED';
ALTER TABLE ledger_entries ADD COLUMN memo text;
ALTER TABLE ledger_entries ALTER COLUMN note SET NOT NULL;
ALTER TABLE ledger_entries ADD CONSTRAINT amount_positive CHECK (amount > 0);`,
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(found(json), ['not-null ledger_entries.currency', 'not-null ledger_entries.note']);
    assert.equal(find(json, 'not-null', 'ledger_entries.currency').severity, 'high');
    assert.equal(find(json, 'not-null', 'ledger_entries.note').severity, 'medium');
  });

  test('UPDATE: self-referencing is an in-place conversion, filling another column is a backfill', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V2__data.sql`]: `UPDATE ledger_entries SET amount = amount * 100;
UPDATE ledger_entries le SET amount_minor = round(le.amount * 100)::bigint WHERE amount_minor IS NULL;
UPDATE ledger_entries SET note = 'amount = amount' WHERE id = 1;`,
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(found(json), [
      'backfill ledger_entries.amount_minor',
      'backfill ledger_entries.note',
      'in-place-conversion ledger_entries.amount',
    ]);
    assert.equal(find(json, 'backfill', 'ledger_entries.amount_minor').severity, 'low');
  });

  test('a trivial USING cast is a retype but not a conversion', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V2__widen.sql`]: 'ALTER TABLE ledger_entries ALTER COLUMN amount SET DATA TYPE numeric(14,2) USING amount::numeric(14,2);',
    }).commit();
    assert.deepEqual(found(scan(r).json), ['column-retype ledger_entries.amount']);
  });

  test('table rename, MySQL and SQL Server dialects', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V2__dialects.sql`]: `ALTER TABLE ledger_entries RENAME TO ledger;
RENAME TABLE a TO b, c TO d;
ALTER TABLE t MODIFY COLUMN qty bigint NOT NULL;
ALTER TABLE t CHANGE COLUMN qty quantity bigint;
EXEC sp_rename 'dbo.Ledger.Amount', 'AmountMinor', 'COLUMN';
GO
ALTER TABLE [dbo].[Ledger] ALTER COLUMN [Note] nvarchar(20) NOT NULL
GO
DELETE FROM audit WHERE created < now();
TRUNCATE TABLE scratch;`,
    }).commit();

    assert.deepEqual(found(scan(r).json), [
      'column-rename Ledger.Amount',
      'column-rename t.qty',
      'column-retype Ledger.Note',
      'column-retype t.qty',
      'column-retype t.qty',
      'not-null Ledger.Note',
      'not-null t.qty',
      'row-delete audit',
      'row-delete scratch',
      'table-rename a',
      'table-rename c',
      'table-rename ledger_entries',
    ]);
  });

  test('statements inside DO blocks are scanned; function bodies are not', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V2__plpgsql.sql`]: `DO $$
BEGIN
  UPDATE ledger_entries SET amount = amount / 100;
END $$;
CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  UPDATE other SET x = x + 1;
  RETURN NEW;
END $body$;`,
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(found(json), ['in-place-conversion ledger_entries.amount']);
    assert.equal(json.findings[0].line, 3);
  });

  test('editing an applied migration is flagged, and only its new statements are scanned', () => {
    const r = repo({
      [`${MIG}/V1__init.sql`]: V1,
      [`${MIG}/V2__drop_note.sql`]: 'ALTER TABLE ledger_entries DROP COLUMN note;\n',
    }).branch('feature').write({
      [`${MIG}/V2__drop_note.sql`]: 'ALTER TABLE ledger_entries DROP COLUMN note;\nALTER TABLE ledger_entries RENAME COLUMN amount TO total;\n',
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(found(json), ['applied-migration-edited V2__drop_note.sql', 'column-rename ledger_entries.amount']);
    assert.equal(find(json, 'applied-migration-edited').line, 2);
    assert.equal(find(json, 'applied-migration-edited').severity, 'high');
  });

  test('deleting an applied migration is flagged; editing a repeatable one is not', () => {
    const r = repo({
      [`${MIG}/V1__init.sql`]: V1,
      [`${MIG}/R__views.sql`]: 'CREATE OR REPLACE VIEW v AS SELECT 1;\n',
    }).branch('feature').remove(`${MIG}/V1__init.sql`).write({
      [`${MIG}/R__views.sql`]: 'CREATE OR REPLACE VIEW v AS SELECT 2;\n',
    }).commit();

    assert.deepEqual(found(scan(r).json), ['applied-migration-edited V1__init.sql']);
  });

  test('ignores SQL outside migration folders and Flyway undo scripts', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      'svc/src/main/resources/queries/report.sql': 'DROP TABLE ledger_entries;',
      [`${MIG}/U2__undo.sql`]: 'DROP TABLE ledger_entries;',
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(json.findings, []);
    assert.deepEqual(json.migrations.map((m) => m.file), [`${MIG}/U2__undo.sql`]);
  });

  test('uses the merge base: changes that only landed on main are not reported', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V3__add.sql`]: 'ALTER TABLE ledger_entries ADD COLUMN memo text;',
    }).commit().checkout('main').write({
      [`${MIG}/V2__on_main.sql`]: 'ALTER TABLE ledger_entries DROP COLUMN note;',
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(json.findings, []);
    assert.deepEqual(json.migrations.map((m) => m.file), [`${MIG}/V3__add.sql`]);
  });

  test('--worktree includes uncommitted and untracked files', () => {
    const r = repo({ [`${MIG}/V1__init.sql`]: V1 }).branch('feature').write({
      [`${MIG}/V2__wip.sql`]: 'ALTER TABLE ledger_entries DROP COLUMN note;',
    });
    assert.deepEqual(scan(r).json.findings, []);
    assert.deepEqual(found(scan(r, '--worktree').json), ['column-drop ledger_entries.note']);
  });
});

describe('scan-migrations: Liquibase', () => {
  test('XML: renameColumn, dropColumn, addColumn NOT NULL, update and inline sql', () => {
    const r = repo({
      'db/changelog/changes.xml': `<?xml version="1.0"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="1" author="ana">
    <createTable tableName="ledger"><column name="amount" type="decimal(12,2)"/></createTable>
  </changeSet>
</databaseChangeLog>
`,
    }).branch('feature').write({
      'db/changelog/changes.xml': `<?xml version="1.0"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="1" author="ana">
    <createTable tableName="ledger"><column name="amount" type="decimal(12,2)"/></createTable>
  </changeSet>
  <changeSet id="2" author="ben">
    <renameColumn tableName="ledger" oldColumnName="amount" newColumnName="amount_minor"/>
    <modifyDataType tableName="ledger" columnName="amount_minor" newDataType="bigint"/>
    <dropColumn tableName="ledger"><column name="memo"/><column name="note"/></dropColumn>
    <addColumn tableName="ledger">
      <column name="currency" type="varchar(3)"><constraints nullable="false"/></column>
      <column name="status" type="text" defaultValue="NEW"><constraints nullable="false"/></column>
    </addColumn>
    <update tableName="ledger"><column name="amount_minor" valueComputed="amount_minor * 100"/></update>
    <sql><![CDATA[DROP TABLE legacy;]]></sql>
  </changeSet>
</databaseChangeLog>
`,
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(found(json), [
      'column-drop ledger.memo',
      'column-drop ledger.note',
      'column-rename ledger.amount',
      'column-retype ledger.amount_minor',
      'in-place-conversion ledger.amount_minor',
      'not-null ledger.currency',
      'table-drop legacy',
    ]);
    assert.equal(find(json, 'column-rename').line, 7);
    assert.equal(find(json, 'table-drop').line, 15);
  });

  test('XML: editing an existing changeSet is flagged; adding a new one is not', () => {
    const before = `<databaseChangeLog>
  <changeSet id="1" author="ana"><addColumn tableName="t"><column name="a" type="int"/></addColumn></changeSet>
</databaseChangeLog>`;
    const r = repo({ 'db/changelog/master.xml': before }).branch('feature').write({
      'db/changelog/master.xml': `<databaseChangeLog>
  <changeSet id="1" author="ana"><addColumn tableName="t"><column name="b" type="int"/></addColumn></changeSet>
  <changeSet id="2" author="ana"><addColumn tableName="t"><column name="c" type="int"/></addColumn></changeSet>
</databaseChangeLog>`,
    }).commit();

    assert.deepEqual(found(scan(r).json), ['applied-migration-edited changeSet ana:1']);
  });

  test('YAML and formatted SQL changelogs', () => {
    const r = repo({ 'README.md': 'x' }).branch('feature').write({
      'db/changelog/002.yaml': `databaseChangeLog:
  - changeSet:
      id: 2
      author: ben
      changes:
        - renameColumn:
            tableName: ledger
            oldColumnName: amount
            newColumnName: amount_minor
        - dropTable:
            tableName: legacy
        - sql:
            sql: UPDATE ledger SET amount_minor = amount_minor * 100
`,
      'db/changelog/003.sql': `--liquibase formatted sql
--changeset ben:3
ALTER TABLE ledger DROP COLUMN note;
`,
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(found(json), [
      'column-drop ledger.note',
      'column-rename ledger.amount',
      'in-place-conversion ledger.amount_minor',
      'table-drop legacy',
    ]);
    assert.deepEqual(json.migrations.map((m) => m.kind).sort(), ['liquibase-sql', 'liquibase-yaml']);
  });

  test('a JSON file that is not a changelog is ignored', () => {
    const r = repo({ 'README.md': 'x' }).branch('feature').write({
      'db/changelog/notes.json': '{"dropColumn": "not liquibase"}',
    }).commit();
    assert.deepEqual(scan(r).json.migrations, []);
  });
});

describe('scan-migrations: EF Core', () => {
  test('only Up() is scanned; Designer and snapshot files are ignored', () => {
    const r = repo({ 'README.md': 'x' }).branch('feature').write({
      'src/Ledger/Migrations/20261003_MinorUnits.cs': `using Microsoft.EntityFrameworkCore.Migrations;
public partial class MinorUnits : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.RenameColumn(name: "Amount", table: "LedgerEntries", newName: "AmountMinor");
        migrationBuilder.AlterColumn<long>(name: "AmountMinor", table: "LedgerEntries", nullable: false,
            oldClrType: typeof(decimal), oldType: "decimal(12,2)", oldNullable: true);
        migrationBuilder.AddColumn<string>(name: "Currency", table: "LedgerEntries", nullable: false);
        migrationBuilder.AddColumn<int>(name: "Version", table: "LedgerEntries", nullable: false, defaultValue: 0);
        migrationBuilder.Sql(@"UPDATE ""LedgerEntries"" SET ""AmountMinor"" = ""AmountMinor"" * 100");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "Currency", table: "LedgerEntries");
        migrationBuilder.RenameColumn(name: "AmountMinor", table: "LedgerEntries", newName: "Amount");
    }
}
`,
      'src/Ledger/Migrations/20261003_MinorUnits.Designer.cs': 'migrationBuilder.DropTable(name: "X");',
      'src/Ledger/Migrations/LedgerContextModelSnapshot.cs': 'migrationBuilder.DropTable(name: "X");',
    }).commit();

    const { json } = scan(r);
    assert.deepEqual(found(json), [
      'column-rename LedgerEntries.Amount',
      'column-retype LedgerEntries.AmountMinor',
      'in-place-conversion LedgerEntries.AmountMinor',
      'not-null LedgerEntries.AmountMinor',
      'not-null LedgerEntries.Currency',
    ]);
    assert.equal(find(json, 'column-rename').line, 6);
    assert.deepEqual(json.migrations.map((m) => m.kind), ['ef-core']);
  });
});

describe('scan-migrations: contract', () => {
  test('bad ref: still exit 0, JSON with an error', () => {
    const r = repo({ 'README.md': 'x' });
    const { status, json } = run('scan-migrations.mjs', ['--repo', r.dir, '--base', 'nope', '--head', 'HEAD']);
    assert.equal(status, 0);
    assert.deepEqual(json.findings, []);
    assert.match(json.errors[0], /unknown ref "nope"/);
  });

  test('missing --base: exit 0 with an error', () => {
    const { status, json } = run('scan-migrations.mjs', []);
    assert.equal(status, 0);
    assert.match(json.errors[0], /--base is required/);
  });

  test('--help prints usage', () => {
    const { status, stdout } = run('scan-migrations.mjs', ['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /^Usage: node scan-migrations\.mjs/);
  });

  test('splitSql honours quotes, dollar quotes and comments', () => {
    const parts = splitSql(`SELECT ';' AS a; -- ; in a comment
SELECT $x$ ; $x$; /* ; */ SELECT "a;b"`);
    assert.deepEqual(parts.map((p) => p.text), [`SELECT ';' AS a`, 'SELECT $x$ ; $x$', 'SELECT "a;b"']);
  });
});
