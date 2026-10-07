// Consistency checks for the deliverable: SKILL.md frontmatter rules from docs/copilot-formats.md,
// references that exist, and a pattern-catalogue entry for every pattern id the scripts can emit.
// Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, '.github/skills/one-way-door');
const read = (p) => fs.readFileSync(path.join(SKILL_DIR, p), 'utf8');

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md must start with YAML frontmatter');
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1').replace(/''/g, "'");
  }
  return { fields, body: text.slice(m[0].length) };
}

test('SKILL.md frontmatter follows the Copilot rules', () => {
  const { fields, body } = frontmatter(read('SKILL.md'));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'license', 'name']);
  assert.equal(fields.name, path.basename(SKILL_DIR), 'name must equal the folder name');
  assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fields.name.length <= 64);
  assert.ok(fields.description.length >= 10 && fields.description.length <= 1024, `description is ${fields.description.length} chars`);
  for (const trigger of [/review/i, /deploy|release/i, /migration/i, /schema|event/i, /roll back/i]) {
    assert.match(fields.description, trigger);
  }
  assert.ok(body.split('\n').length < 500, 'body must stay under 500 lines');
});

test('every file SKILL.md mentions exists', () => {
  const body = read('SKILL.md');
  const refs = [...body.matchAll(/`((?:references|scripts)\/[\w./-]+)`/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4);
  for (const ref of new Set(refs)) assert.ok(fs.existsSync(path.join(SKILL_DIR, ref)), `missing ${ref}`);
});

test('every pattern id the scripts emit has an entry in patterns.md', () => {
  const catalogue = read('references/patterns.md');
  const headings = new Set([...catalogue.matchAll(/^### `([a-z-]+)`/gm)].map((m) => m[1]));
  const emitted = new Set();
  for (const script of ['scripts/scan-migrations.mjs', 'scripts/schema-compat.mjs']) {
    const src = read(script);
    for (const m of src.matchAll(/(?:add|report|edited)\(\s*'([a-z]+(?:-[a-z]+)+)'/g)) emitted.add(m[1]);
    for (const m of src.matchAll(/pattern: '([a-z]+(?:-[a-z]+)+)'/g)) emitted.add(m[1]);
    for (const m of src.matchAll(/^\s+'([a-z]+(?:-[a-z]+)+)': '(?:high|medium|low)'/gm)) emitted.add(m[1]);
  }
  assert.ok(emitted.size >= 15, `found only ${emitted.size} pattern ids`);
  for (const id of emitted) assert.ok(headings.has(id), `patterns.md has no entry for ${id}`);
});

test('the catalogue covers the required patterns', () => {
  const catalogue = read('references/patterns.md');
  for (const id of [
    'column-rename', 'column-drop', 'column-retype', 'not-null', 'in-place-conversion', 'event-field-removed',
    'event-field-renamed', 'event-field-retyped', 'event-enum-value-added', 'strict-consumer-new-field',
    'missing-primitive-default', 'cache-format-change', 'idempotency-key-format-change',
    'servicebus-entity-deleted', 'apim-version-removed', 'webhook-payload-change', 'applied-migration-edited',
  ]) assert.match(catalogue, new RegExp(`^### \`${id}\``, 'm'), id);
  for (const group of ['## Data', '## Messages', '## State', '## External']) assert.ok(catalogue.includes(group), group);
});

test('the output format has a verdict line, numbered findings, blast radius and a split offer', () => {
  const format = read('references/output-format.md');
  assert.match(format, /\*\*Verdict: <ONE-WAY \| TWO-WAY>\*\* · Safe rollback window:/);
  for (const s of ['**Door closes:**', '**If rolled back:**', '**Data loss:**', '### Blast radius', '### Suggested split', 'generate the split']) {
    assert.ok(format.includes(s), s);
  }
});

test('PR #482 appears in the references, not in SKILL.md', () => {
  assert.doesNotMatch(read('SKILL.md'), /482|£0\.00|ledger_entries/);
  assert.match(read('references/patterns.md'), /PR #482/);
  assert.match(read('references/output-format.md'), /PR #482/);
});
