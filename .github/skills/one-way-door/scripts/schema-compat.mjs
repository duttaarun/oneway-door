#!/usr/bin/env node
// schema-compat: compares JSON Schema event contracts between two git refs in the
// OLD-READER direction: can consumers built against the base schema read events the head
// producer writes? Also flags what new consumers will meet in old events (backlog, replay,
// a producer rolled back), because that is the other half of a rollback.
//
// Node 20+, standard library only, no network. Prints JSON on stdout and always exits 0.
import {
  changedFiles, lineAt, listFilesAt, parseArgs, readSide, resolveRange, run, sortFindings, summarise,
} from './lib/common.mjs';

const HELP = `Usage: node schema-compat.mjs --base <ref> [--head <ref>] [--dir <path>]... [--repo <path>] [--worktree]

Diffs each JSON Schema that changed between the merge base of <base> and <head> and flags:

  event-field-removed, event-field-renamed, event-field-retyped, event-field-made-optional,
  event-enum-value-added, event-required-field-added, strict-consumer-new-field,
  missing-primitive-default, event-schema-deleted

Pattern ids match references/patterns.md.

Options:
  --base <ref>    Base branch or commit (required)
  --head <ref>    Head ref (default HEAD)
  --dir <path>    Folder of JSON Schemas (default contracts/events). Repeat for several.
                  If none of the folders exist, every changed *.schema.json in the repo is checked.
  --repo <path>   Repository path (default: current directory)
  --worktree      Compare the merge base with the working tree, uncommitted files included
  --help          Show this help

Output: JSON { tool, base, head, mergeBase, schemas[], findings[], summary, errors[] }.
Each finding: { file, line, baseLine, pattern, object, severity, detail }.
Exit code is always 0; findings are data, not errors.
`;

// ---------------------------------------------------------------- schema helpers

function resolveRef(node, root, seen = new Set()) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string' || !node.$ref.startsWith('#')) return node;
  if (seen.has(node.$ref)) return node;
  seen.add(node.$ref);
  let target = root;
  for (const raw of node.$ref.replace(/^#\/?/, '').split('/').filter(Boolean)) {
    target = target?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (!target) return node;
  const { $ref, ...rest } = node;
  return resolveRef({ ...target, ...rest }, root, seen);
}

/** Normalised set of JSON types a node allows. `integer` stays distinct from `number`. */
export function typesOf(node) {
  if (!node || typeof node !== 'object') return new Set();
  const out = new Set();
  const add = (t) => out.add(t);
  if (Array.isArray(node.type)) node.type.forEach(add);
  else if (typeof node.type === 'string') add(node.type);
  else if (node.properties) add('object');
  else if (node.items) add('array');
  else if (Array.isArray(node.enum)) {
    for (const v of node.enum) add(v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v === 'number' ? 'number' : typeof v);
  } else if ('const' in node) add(typeof node.const);
  if (node.nullable === true) add('null');
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(node[key])) for (const sub of node[key]) for (const t of typesOf(sub)) add(t);
  }
  return out;
}

/** Can a reader expecting `oldTypes` read a value of `newTypes`? */
function readable(oldTypes, newTypes) {
  if (oldTypes.size === 0) return true; // the old schema didn't constrain it
  for (const t of newTypes) {
    if (oldTypes.has(t)) continue;
    if (t === 'integer' && oldTypes.has('number')) continue;
    return false;
  }
  return true;
}

const fmt = (types) => [...types].sort().join(' | ') || 'any';
const isScalarDefaulting = (types) => [...types].some((t) => t === 'number' || t === 'integer' || t === 'boolean') && !types.has('null');

function similar(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.includes(y) || y.includes(x)) return true;
  let prefix = 0;
  while (prefix < x.length && x[prefix] === y[prefix]) prefix++;
  return prefix >= 4;
}

/**
 * Line of the property definition `"key":` for a dotted path, searching each part after the previous one.
 * With `container`, returns the line of the parent's "properties" (where a removed field used to be).
 */
function keyLine(text, pathParts, { container = false } = {}) {
  if (!text) return null;
  const find = (key, from) => {
    const m = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'g');
    m.lastIndex = from;
    const hit = m.exec(text);
    return hit ? hit.index : -1;
  };
  let from = 0;
  let found = -1;
  for (const part of container ? [...pathParts, 'properties'] : pathParts) {
    const idx = find(part, from);
    if (idx === -1) return found === -1 ? null : lineAt(text, found);
    found = idx;
    from = idx + 1;
  }
  return found === -1 ? null : lineAt(text, found);
}

// ---------------------------------------------------------------- comparison

export function compareSchemas(baseSchema, headSchema, { file, baseText = '', headText = '' } = {}) {
  const findings = [];
  const title = headSchema?.title ?? baseSchema?.title ?? file.split('/').pop().replace(/(\.schema)?\.json$/, '');
  const add = (pattern, severity, path, detail, { onBase = false } = {}) => {
    const parts = path.split('.').filter((p) => p && p !== '[]');
    findings.push({
      file,
      line: onBase ? keyLine(headText, parts.slice(0, -1), { container: true }) : keyLine(headText, parts),
      baseLine: keyLine(baseText, parts),
      pattern,
      object: path ? `${title}.${path}` : title,
      severity,
      detail,
    });
  };

  const walk = (rawOld, rawNew, path) => {
    const oldNode = resolveRef(rawOld, baseSchema);
    const newNode = resolveRef(rawNew, headSchema);
    if (!oldNode || !newNode) return;
    const oldTypes = typesOf(oldNode);
    const newTypes = typesOf(newNode);
    const label = path || title;

    const gainedNull = newTypes.has('null') && !oldTypes.has('null') && oldTypes.size > 0;
    const newNonNull = new Set([...newTypes].filter((t) => !gainedNull || t !== 'null'));
    if (path && !readable(oldTypes, newNonNull)) {
      add('event-field-retyped', 'high', path, `${label}: ${fmt(oldTypes)} → ${fmt(newTypes)}; old readers expect ${fmt(oldTypes)}`);
    } else if (path && gainedNull) {
      add('event-field-made-optional', 'medium', path, `${label} can now be null`);
    }
    if (path && oldNode.format && newNode.format && oldNode.format !== newNode.format) {
      add('event-field-retyped', 'medium', path, `${label}: format ${oldNode.format} → ${newNode.format}`);
    }
    if (Array.isArray(newNode.enum) && Array.isArray(oldNode.enum)) {
      const added = newNode.enum.filter((v) => !oldNode.enum.some((o) => JSON.stringify(o) === JSON.stringify(v)));
      if (added.length) {
        add('event-enum-value-added', 'medium', path, `${label}: new value${added.length > 1 ? 's' : ''} ${added.map((v) => JSON.stringify(v)).join(', ')}; old readers may reject them`);
      }
    }

    if (oldNode.properties || newNode.properties) compareObject(oldNode, newNode, path);
    if (oldNode.items && newNode.items && !Array.isArray(oldNode.items) && !Array.isArray(newNode.items)) {
      walk(oldNode.items, newNode.items, `${path}[]`);
    }
  };

  const compareObject = (oldNode, newNode, path) => {
    const oldProps = oldNode.properties ?? {};
    const newProps = newNode.properties ?? {};
    const oldReq = new Set(oldNode.required ?? []);
    const newReq = new Set(newNode.required ?? []);
    const at = (name) => (path ? `${path}.${name}` : name);
    const removed = Object.keys(oldProps).filter((k) => !(k in newProps));
    const added = Object.keys(newProps).filter((k) => !(k in oldProps));

    for (const name of removed) {
      const types = typesOf(resolveRef(oldProps[name], baseSchema));
      if (oldReq.has(name)) {
        add('event-field-removed', 'high', at(name), `required field ${name} (${fmt(types)}) removed; old readers expect it in every event`, { onBase: true });
        if (isScalarDefaulting(types)) {
          add('missing-primitive-default', 'high', at(name), `old readers that bind ${name} to a primitive (double/long/int/boolean) will read 0 or false, silently`, { onBase: true });
        }
      } else {
        add('event-field-removed', 'low', at(name), `optional field ${name} removed`, { onBase: true });
      }
    }

    for (const name of added) {
      const node = resolveRef(newProps[name], headSchema);
      const types = typesOf(node);
      if (newReq.has(name)) {
        add('event-required-field-added', 'high', at(name), `new required field ${name} (${fmt(types)}); new readers will meet old events without it (backlog, replay, rolled-back producer)`);
        if (isScalarDefaulting(types)) {
          add('missing-primitive-default', 'high', at(name), `new readers that bind ${name} to a primitive will read 0 or false from old events, silently`);
        }
      } else if (oldNode.additionalProperties === false) {
        add('strict-consumer-new-field', 'high', at(name), `new field ${name}, but the base schema sets additionalProperties: false; strict readers will reject it`);
      } else {
        add('strict-consumer-new-field', 'low', at(name), `new optional field ${name}; check for consumers with FAIL_ON_UNKNOWN_PROPERTIES or strict validation`);
      }
    }

    // A field removed and another added in the same object: probably a rename.
    const pool = [...added];
    for (const name of removed) {
      let match = pool.find((a) => similar(name, a));
      if (!match && removed.length === 1 && pool.length === 1) [match] = pool;
      if (!match) continue;
      pool.splice(pool.indexOf(match), 1);
      add('event-field-renamed', oldReq.has(name) ? 'high' : 'medium', at(match),
        `${name} → ${match} (removed and added in the same change); old readers see ${name} missing and ignore ${match}`);
    }

    for (const name of Object.keys(oldProps).filter((k) => k in newProps)) {
      if (oldReq.has(name) && !newReq.has(name)) {
        add('event-field-made-optional', 'medium', at(name), `${name} is no longer required; old readers expect it in every event`);
      }
      walk(oldProps[name], newProps[name], at(name));
    }
  };

  walk(baseSchema, headSchema, '');
  return findings;
}

// ---------------------------------------------------------------- main

function main(argv) {
  const args = parseArgs(argv, { flags: ['worktree'], multi: ['dir'] });
  if (!args.base) throw new Error('--base is required (see --help)');
  const range = resolveRange({ repo: args.repo ?? process.cwd(), base: args.base, head: args.head ?? 'HEAD', worktree: !!args.worktree });
  const dirs = (args.dir ?? ['contracts/events']).map((d) => d.replace(/\/+$/, ''));
  const errors = [];

  const existing = dirs.filter((d) => listFilesAt(range, 'head', d).length || listFilesAt(range, 'base', d).length);
  const inScope = existing.length
    ? (p) => existing.some((d) => p === d || p.startsWith(`${d}/`)) && p.endsWith('.json')
    : (p) => p.endsWith('.schema.json');
  if (!existing.length) {
    errors.push(`none of ${dirs.join(', ')} exist at base or head; checked every changed *.schema.json instead`);
  }

  const schemas = [];
  const findings = [];
  for (const f of changedFiles(range)) {
    if (!inScope(f.path) && !(f.oldPath && inScope(f.oldPath))) continue;
    schemas.push({ file: f.path, status: f.status, ...(f.oldPath ? { renamedFrom: f.oldPath } : {}) });
    const baseText = readSide(range, 'base', f.oldPath ?? f.path);
    const headText = f.status === 'D' ? null : readSide(range, 'head', f.path);
    if (headText == null) {
      findings.push({ file: f.path, line: null, baseLine: 1, pattern: 'event-schema-deleted', object: f.path.split('/').pop(), severity: 'medium', detail: 'schema deleted; check nothing still produces or consumes this event' });
      continue;
    }
    if (baseText == null) continue; // a new event type: nothing old can misread it
    let baseSchema;
    let headSchema;
    try { baseSchema = JSON.parse(baseText); } catch (err) { errors.push(`${f.path} (base): invalid JSON: ${err.message}`); continue; }
    try { headSchema = JSON.parse(headText); } catch (err) { errors.push(`${f.path} (head): invalid JSON: ${err.message}`); continue; }
    findings.push(...compareSchemas(baseSchema, headSchema, { file: f.path, baseText, headText }));
  }

  return {
    tool: 'schema-compat',
    version: 1,
    direction: 'old-reader',
    base: range.base,
    head: range.head,
    mergeBase: range.mergeBase,
    dirs: existing.length ? existing : dirs,
    schemas,
    findings: sortFindings(findings),
    summary: summarise(findings),
    errors,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('schema-compat.mjs')) {
  run('schema-compat', main, HELP);
}
