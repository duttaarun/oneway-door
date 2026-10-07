import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { compat, find, found, makeRepo, run } from './helpers.mjs';
import { compareSchemas } from '../schema-compat.mjs';

const FILE = 'contracts/events/payment-settled.schema.json';
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

const V1 = {
  title: 'PaymentSettled',
  type: 'object',
  required: ['paymentId', 'currency', 'amount', 'settledAt'],
  properties: {
    paymentId: { type: 'string', format: 'uuid' },
    currency: { type: 'string', enum: ['GBP', 'EUR'] },
    amount: { type: 'number' },
    settledAt: { type: 'string', format: 'date-time' },
    note: { type: 'string' },
  },
};

const repos = [];
const repoWith = (head, base = V1, file = FILE) => {
  const r = makeRepo({ [file]: json(base) }).branch('feature').write({ [file]: json(head) }).commit();
  repos.push(r);
  return r;
};
after(() => repos.forEach((r) => r.cleanup()));

describe('schema-compat (old-reader direction)', () => {
  test('PR #482: amount replaced by amountMinor', () => {
    const v2 = structuredClone(V1);
    delete v2.properties.amount;
    v2.properties.amountMinor = { type: 'integer', minimum: 1 };
    v2.required = ['paymentId', 'currency', 'amountMinor', 'settledAt'];

    const { status, json: out } = compat(repoWith(v2));
    assert.equal(status, 0);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(found(out), [
      'event-field-removed PaymentSettled.amount',
      'event-field-renamed PaymentSettled.amountMinor',
      'event-required-field-added PaymentSettled.amountMinor',
      'missing-primitive-default PaymentSettled.amount',
      'missing-primitive-default PaymentSettled.amountMinor',
    ]);
    assert.ok(out.findings.every((f) => f.severity === 'high'));
    assert.match(find(out, 'event-field-renamed').detail, /amount → amountMinor/);
    assert.equal(find(out, 'event-field-removed').baseLine, 22);
    assert.equal(find(out, 'event-required-field-added').line, 29);
  });

  test('type changes: integer→number and number→string break old readers; number→integer does not', () => {
    const base = { ...V1, properties: { ...V1.properties, count: { type: 'integer' }, ratio: { type: 'number' }, fee: { type: 'number' } } };
    const head = { ...base, properties: { ...base.properties, count: { type: 'number' }, ratio: { type: 'integer' }, fee: { type: 'string' } } };
    const { json: out } = compat(repoWith(head, base));
    assert.deepEqual(found(out), ['event-field-retyped PaymentSettled.count', 'event-field-retyped PaymentSettled.fee']);
    assert.match(find(out, 'event-field-retyped', 'PaymentSettled.fee').detail, /number → string/);
  });

  test('enum value added, format changed, made optional, made nullable', () => {
    const head = structuredClone(V1);
    head.properties.currency.enum.push('USD');
    head.properties.settledAt.format = 'date';
    head.properties.paymentId.type = ['string', 'null'];
    head.required = ['paymentId', 'currency', 'settledAt'];
    const { json: out } = compat(repoWith(head));
    assert.deepEqual(found(out), [
      'event-enum-value-added PaymentSettled.currency',
      'event-field-made-optional PaymentSettled.amount',
      'event-field-made-optional PaymentSettled.paymentId',
      'event-field-retyped PaymentSettled.settledAt',
    ]);
    assert.match(find(out, 'event-enum-value-added').detail, /"USD"/);
    assert.equal(find(out, 'event-field-retyped').severity, 'medium');
  });

  test('optional field added: low normally, high when the base schema is closed', () => {
    const head = { ...V1, properties: { ...V1.properties, merchantRef: { type: 'string' } } };
    assert.equal(find(compat(repoWith(head)).json, 'strict-consumer-new-field').severity, 'low');

    const closed = { ...V1, additionalProperties: false };
    const { json: out } = compat(repoWith({ ...head, additionalProperties: false }, closed));
    assert.equal(find(out, 'strict-consumer-new-field').severity, 'high');
  });

  test('optional field removed is low and is not a primitive default', () => {
    const head = structuredClone(V1);
    delete head.properties.note;
    assert.deepEqual(found(compat(repoWith(head)).json), ['event-field-removed PaymentSettled.note']);
    assert.equal(find(compat(repoWith(head)).json, 'event-field-removed').severity, 'low');
  });

  test('nested objects, arrays and local $refs', () => {
    const base = {
      title: 'Batch',
      type: 'object',
      $defs: { money: { type: 'object', required: ['value'], properties: { value: { type: 'number' }, currency: { type: 'string' } } } },
      properties: {
        total: { $ref: '#/$defs/money' },
        lines: { type: 'array', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, qty: { type: 'integer' } } } },
      },
    };
    const head = structuredClone(base);
    delete head.$defs.money.properties.value;
    head.$defs.money.required = [];
    head.properties.lines.items.properties.qty.type = 'string';
    const { json: out } = compat(repoWith(head, base, 'contracts/events/batch.schema.json'));
    assert.deepEqual(found(out), [
      'event-field-removed Batch.total.value',
      'event-field-retyped Batch.lines[].qty',
      'missing-primitive-default Batch.total.value',
    ]);
  });

  test('new schema files are fine; deleted ones are reported; invalid JSON is an error, not a crash', () => {
    const r = makeRepo({
      [FILE]: json(V1),
      'contracts/events/refund-issued.schema.json': json({ title: 'RefundIssued', type: 'object' }),
      'contracts/events/broken.schema.json': json(V1),
    }).branch('feature')
      .remove('contracts/events/refund-issued.schema.json')
      .write({
        'contracts/events/chargeback.schema.json': json({ title: 'Chargeback', type: 'object' }),
        'contracts/events/broken.schema.json': '{ not json',
      })
      .commit();
    repos.push(r);
    const { status, json: out } = compat(r);
    assert.equal(status, 0);
    assert.deepEqual(found(out), ['event-schema-deleted refund-issued.schema.json']);
    assert.equal(out.schemas.length, 3);
    assert.match(out.errors[0], /broken\.schema\.json \(head\): invalid JSON/);
  });

  test('--dir scopes the search; a missing dir falls back to *.schema.json with a note', () => {
    const head = structuredClone(V1);
    delete head.properties.amount;
    const r = makeRepo({ 'events/x.schema.json': json(V1), 'other/y.json': json(V1) }).branch('feature')
      .write({ 'events/x.schema.json': json(head), 'other/y.json': json(head) }).commit();
    repos.push(r);

    const scoped = compat(r, '--dir', 'other').json;
    assert.deepEqual(scoped.schemas.map((s) => s.file), ['other/y.json']);

    const fallback = compat(r, '--dir', 'nowhere').json;
    assert.deepEqual(fallback.schemas.map((s) => s.file), ['events/x.schema.json']);
    assert.match(fallback.errors[0], /checked every changed \*\.schema\.json/);
  });

  test('compareSchemas is pure and order-stable', () => {
    const head = structuredClone(V1);
    head.properties.amount.type = 'string';
    const a = compareSchemas(V1, head, { file: FILE });
    const b = compareSchemas(V1, head, { file: FILE });
    assert.deepEqual(a, b);
    assert.equal(a.length, 1);
  });

  test('--help prints usage and bad refs never crash', () => {
    assert.match(run('schema-compat.mjs', ['--help']).stdout, /^Usage: node schema-compat\.mjs/);
    const r = makeRepo({ 'x.txt': 'x' });
    repos.push(r);
    const out = run('schema-compat.mjs', ['--repo', r.dir, '--base', 'missing']);
    assert.equal(out.status, 0);
    assert.match(out.json.errors[0], /unknown ref "missing"/);
  });
});
