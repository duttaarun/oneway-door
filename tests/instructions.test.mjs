// Checks that .github/instructions/migrations.instructions.md applies to the right files.
// Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.github/instructions/migrations.instructions.md');

/** Glob → RegExp with the usual semantics: ** spans folders (including none), * and ? stay inside one. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function applyTo() {
  const text = fs.readFileSync(FILE, 'utf8');
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(front, 'frontmatter missing');
  const m = front[1].match(/^applyTo:\s*"([^"]+)"\s*$/m);
  assert.ok(m, 'applyTo must be one quoted, comma-separated string');
  return m[1].split(',').map((g) => g.trim());
}

const matches = (p) => applyTo().some((g) => globToRegExp(g).test(p));

test('applyTo covers migration folders and event contracts', () => {
  for (const p of [
    'demo/ledger-service/src/main/resources/db/migration/V1__create_ledger_entries.sql',
    'demo/ledger-service/src/main/resources/db/migration/V42__amount_minor_units.sql',
    'db/migration/V7__x.sql',
    'db/changelog/db.changelog-master.yaml',
    'service/src/main/resources/db/changelog/changes/002.xml',
    'src/Ledger.Data/Migrations/20261003120000_MinorUnits.cs',
    'app/migrations/0004_amount_minor.py',
    'infra/liquibase/changelog.xml',
    'contracts/events/payment-settled.schema.json',
  ]) assert.ok(matches(p), `should apply to ${p}`);
});

test('applyTo leaves ordinary code and docs alone', () => {
  for (const p of [
    'demo/ledger-service/src/main/java/com/northwind/ledger/LedgerEntry.java',
    'demo/settlement-service/src/main/resources/application.yml',
    'README.md',
    'docs/progress.md',
    '.github/skills/one-way-door/SKILL.md',
    'contracts/README.md',
  ]) assert.ok(!matches(p), `should not apply to ${p}`);
});

test('every migration and contract in this repo is covered', () => {
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const files = [...walk('demo'), ...walk('contracts')]
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => /\/db\/migration\/.*\.sql$/.test(p) || p.startsWith('contracts/events/'));
  assert.ok(files.length >= 3);
  for (const p of files) assert.ok(matches(p), `should apply to ${p}`);
});

test('the instructions point at the one-way-door skill and the split', () => {
  const text = fs.readFileSync(FILE, 'utf8');
  assert.match(text, /one-way-door/);
  assert.match(text, /expand → migrate → contract → drop/);
});
