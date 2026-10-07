#!/usr/bin/env node
// scan-migrations: finds destructive or rollback-hostile changes in database migrations
// added or changed between two git refs. Flyway (V/R__*.sql and plain SQL migration folders),
// Liquibase (XML, YAML, JSON, formatted SQL) and EF Core (Migrations/*.cs).
//
// Node 20+, standard library only, no network. Prints JSON on stdout and always exits 0.
import {
  changedFiles, git, lineAt, parseArgs, readSide, resolveRange, run, sortFindings, summarise,
} from './lib/common.mjs';

const HELP = `Usage: node scan-migrations.mjs --base <ref> [--head <ref>] [--repo <path>] [--worktree]

Finds migrations added or changed between the merge base of <base> and <head> and flags
rollback-hostile changes:

  column-rename, table-rename, column-drop, table-drop, column-retype, not-null,
  in-place-conversion, backfill, row-delete, applied-migration-edited

Pattern ids match references/patterns.md.

Options:
  --base <ref>     Base branch or commit (required), e.g. main or origin/main
  --head <ref>     Head ref (default HEAD)
  --repo <path>    Repository path (default: current directory)
  --worktree       Compare the merge base with the working tree, uncommitted files included
  --help           Show this help

Output: JSON { tool, base, head, mergeBase, migrations[], findings[], summary, errors[] }.
Each finding: { file, line, pattern, object, severity, detail, statement }.
Exit code is always 0; findings are data, not errors.
`;

const SEVERITY = {
  'column-rename': 'high',
  'table-rename': 'high',
  'column-drop': 'high',
  'table-drop': 'high',
  'column-retype': 'high',
  'in-place-conversion': 'high',
  'row-delete': 'high',
  'applied-migration-edited': 'high',
  backfill: 'low',
};

// ---------------------------------------------------------------- classification

export function classify(filePath, content) {
  const name = filePath.split('/').pop();
  if (/\.sql$/i.test(name)) {
    const fw = name.match(/^([VUR])(\d+(?:[._]\d+)*)?__.+\.sql$/i);
    if (fw) return { kind: 'flyway', prefix: fw[1].toUpperCase(), version: fw[2]?.replace(/_/g, '.') ?? null };
    if (content && /^\s*--\s*liquibase\s+formatted\s+sql/i.test(content)) return { kind: 'liquibase-sql' };
    if (/(^|\/)(db\/)?(migrations?|flyway|changelogs?|schema-changes)\//i.test(filePath)) return { kind: 'sql' };
    return null;
  }
  if (/\.(xml|ya?ml|json)$/i.test(name) && content && /databaseChangeLog/.test(content)) {
    const ext = name.split('.').pop().toLowerCase();
    return { kind: ext === 'xml' ? 'liquibase-xml' : ext === 'json' ? 'liquibase-json' : 'liquibase-yaml' };
  }
  if (/\.cs$/i.test(name) && /(^|\/)Migrations\//.test(filePath)
      && !/\.Designer\.cs$/i.test(name) && !/ModelSnapshot\.cs$/i.test(name)
      && (!content || /MigrationBuilder/.test(content))) {
    return { kind: 'ef-core' };
  }
  return null;
}

// ---------------------------------------------------------------- SQL

/** Replaces comments with spaces (newlines kept) so offsets and line numbers stay valid. */
export function maskComments(text) {
  const out = text.split('');
  let i = 0;
  let state = null; // ' " ` $
  let tag = null;
  while (i < text.length) {
    const c = text[i];
    if (state === "'") { if (c === "'") { if (text[i + 1] === "'") i++; else state = null; } i++; continue; }
    if (state === '"' || state === '`') { if (c === state) state = null; i++; continue; }
    if (state === '$') {
      if (text.startsWith(tag, i)) { i += tag.length; state = null; } else i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let depth = 0;
      while (i < text.length) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; out[i] = out[i + 1] = ' '; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === '/') { depth--; out[i] = out[i + 1] = ' '; i += 2; if (depth === 0) break; continue; }
        if (text[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { state = c; i++; continue; }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
      if (m) { state = '$'; tag = m[0]; i += m[0].length; continue; }
    }
    i++;
  }
  return out.join('');
}

/** Splits SQL into statements: [{ text, offset }]. Honours quotes, dollar quotes and GO lines. */
export function splitSql(text) {
  const clean = maskComments(text).replace(/^[ \t]*GO[ \t]*$/gim, (m) => ';'.padEnd(m.length, ' '));
  const statements = [];
  let start = 0;
  let state = null;
  let tag = null;
  const push = (from, to) => {
    const raw = clean.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body) statements.push({ text: body, offset: from + lead });
  };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (state === "'") { if (c === "'") { if (clean[i + 1] === "'") i++; else state = null; } continue; }
    if (state === '"' || state === '`') { if (c === state) state = null; continue; }
    if (state === '$') { if (clean.startsWith(tag, i)) { i += tag.length - 1; state = null; } continue; }
    if (c === "'" || c === '"' || c === '`') { state = c; continue; }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(clean.slice(i, i + 64));
      if (m) { state = '$'; tag = m[0]; i += m[0].length - 1; continue; }
    }
    if (c === ';') { push(start, i); start = i + 1; }
  }
  push(start, clean.length);
  return statements;
}

const PART = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const IDENT = String.raw`${PART}(?:\s*\.\s*${PART})*`;
const re = (src, flags = 'i') => new RegExp(src, flags);

/** Last segment of a possibly qualified, possibly quoted identifier. */
export function bare(ident) {
  const parts = ident.match(new RegExp(PART, 'g')) ?? [ident];
  return parts[parts.length - 1].replace(/^["`[]|["`\]]$/g, '').replace(/""/g, '"');
}

/** Splits on commas outside parentheses and quotes; returns [{ text, offset }]. */
function splitTopLevel(text, sepRegex = /,/y) {
  const parts = [];
  let depth = 0;
  let state = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state) { if (c === state) state = null; continue; }
    if (c === "'" || c === '"' || c === '`') { state = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) {
      sepRegex.lastIndex = i;
      const m = sepRegex.exec(text);
      if (m && m.index === i) {
        parts.push({ text: text.slice(start, i), offset: start, sep: m[0] });
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  parts.push({ text: text.slice(start), offset: start, sep: null });
  return parts.map((p) => {
    const lead = p.text.length - p.text.trimStart().length;
    return { text: p.text.trim(), offset: p.offset + lead, sep: p.sep };
  }).filter((p) => p.text);
}

function stripStrings(expr) {
  return expr.replace(/'(?:[^']|'')*'/g, "''");
}

function referencesColumn(expr, column) {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])"?${escaped}"?(?![\\w$])`, 'i').test(stripStrings(expr));
}

function isTrivialCast(expr, column) {
  const e = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  const col = `"?${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`;
  return re(`^${col}(\\s*::\\s*[\\w ]+(\\s*\\(\\s*\\d+(\\s*,\\s*\\d+)?\\s*\\))?)?$`).test(e)
    || re(`^CAST\\s*\\(\\s*${col}\\s+AS\\s+[\\w ]+(\\(\\s*\\d+(\\s*,\\s*\\d+)?\\s*\\))?\\s*\\)$`).test(e);
}

const oneLine = (s, max = 200) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Scans SQL text. `offset` is where `sql` starts inside `fileText` (for line numbers).
 * `skip` is a Set of normalised statements to ignore (already present at the merge base).
 */
export function scanSql(sql, { file, fileText = sql, offset = 0, skip = null } = {}) {
  const findings = [];
  for (const st of splitSql(sql)) {
    const norm = normaliseStatement(st.text);
    if (skip?.has(norm)) continue;
    const doBlock = st.text.match(/^DO\s+(?:LANGUAGE\s+\w+\s+)?(\$[A-Za-z_]*\$)([\s\S]*)\1/i);
    if (doBlock) {
      const bodyOffset = st.offset + st.text.indexOf(doBlock[2], doBlock[1].length);
      // PL/pgSQL block keywords end a statement just like ';' does (same length, so offsets hold).
      const body = sql.slice(bodyOffset, bodyOffset + doBlock[2].length)
        .replace(/\b(END\s+IF|END\s+LOOP|BEGIN|END|DECLARE|THEN|ELSIF|ELSE|LOOP|EXCEPTION)\b/gi, (k) => ';'.padEnd(k.length, ' '));
      findings.push(...scanSql(body, { file, fileText, offset: offset + bodyOffset }));
      continue;
    }
    const add = (pattern, object, detail, atOffset = 0, severity = SEVERITY[pattern]) => findings.push({
      file,
      line: lineAt(fileText, offset + st.offset + atOffset),
      pattern,
      object,
      severity,
      detail,
      statement: oneLine(st.text),
    });
    analyseStatement(st.text, add);
  }
  return findings;
}

export function normaliseStatement(text) {
  return maskComments(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function analyseStatement(s, add) {
  let m;
  // ALTER TABLE t <action>[, <action>…]
  if ((m = re(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})\\s+([\\s\\S]+)$`).exec(s))) {
    const table = bare(m[1]);
    const actionsAt = m.index + m[0].length - m[2].length;
    for (const action of splitTopLevel(m[2])) analyseAlterAction(table, action.text, actionsAt + action.offset, add);
    return;
  }
  if ((m = re(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?([\\s\\S]+?)(?:\\s+(?:CASCADE|RESTRICT|PURGE))?$`).exec(s))) {
    for (const t of splitTopLevel(m[1])) add('table-drop', bare(t.text), `table ${bare(t.text)} dropped`);
    return;
  }
  if ((m = /^RENAME\s+TABLE\s+([\s\S]+)$/i.exec(s))) {
    for (const pair of splitTopLevel(m[1])) {
      const p = re(`^(${IDENT})\\s+TO\\s+(${IDENT})$`).exec(pair.text);
      if (p) add('table-rename', bare(p[1]), `${bare(p[1])} → ${bare(p[2])}`);
    }
    return;
  }
  if ((m = /^(?:EXEC(?:UTE)?\s+)?(?:\w+\.)?sp_rename\s+N?'([^']+)'\s*,\s*N?'([^']+)'(?:\s*,\s*N?'(\w+)')?/i.exec(s))) {
    const from = m[1].split('.').map((x) => x.replace(/^\[|\]$/g, ''));
    if ((m[3] ?? '').toUpperCase() === 'COLUMN') {
      const column = from[from.length - 1];
      const table = from[from.length - 2] ?? '?';
      add('column-rename', `${table}.${column}`, `${column} → ${m[2]}`);
    } else if (!m[3] || m[3].toUpperCase() === 'OBJECT') {
      add('table-rename', from[from.length - 1], `${from[from.length - 1]} → ${m[2]}`);
    }
    return;
  }
  if ((m = re(`^UPDATE\\s+(?:ONLY\\s+)?(${IDENT})\\s+(?:(?:AS\\s+)?(?!SET\\b)${PART}\\s+)?SET\\s+([\\s\\S]+)$`).exec(s))) {
    const table = bare(m[1]);
    const setAt = m.index + m[0].length - m[2].length;
    const clause = splitTopLevel(m[2], /\b(?:FROM|WHERE|RETURNING)\b/iy)[0];
    for (const a of splitTopLevel(clause.text)) {
      const p = re(`^(${IDENT})\\s*=\\s*([\\s\\S]+)$`).exec(a.text);
      if (!p) continue;
      const column = bare(p[1]);
      if (referencesColumn(p[2], column)) {
        add('in-place-conversion', `${table}.${column}`, `values rewritten in place: ${column} = ${oneLine(p[2], 80)}`, setAt + a.offset);
      } else {
        add('backfill', `${table}.${column}`, `${column} filled from ${oneLine(p[2], 80)}`, setAt + a.offset);
      }
    }
    return;
  }
  if ((m = re(`^DELETE\\s+FROM\\s+(?:ONLY\\s+)?(${IDENT})`).exec(s))) {
    add('row-delete', bare(m[1]), `rows deleted from ${bare(m[1])}${/\bWHERE\b/i.test(s) ? ' (with WHERE)' : ' (all rows)'}`);
    return;
  }
  if ((m = re(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${IDENT})`).exec(s))) {
    add('row-delete', bare(m[1]), `table ${bare(m[1])} truncated`);
  }
}

const NOT_A_COLUMN = /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|INDEX|KEY|CHECK|PARTITION|PERIOD|SYSTEM|FULLTEXT|SPATIAL)\b/i;

function analyseAlterAction(table, a, at, add) {
  let m;
  if ((m = re(`^RENAME\\s+TO\\s+(${IDENT})`).exec(a))) {
    return add('table-rename', table, `${table} → ${bare(m[1])}`, at);
  }
  if (/^RENAME\s+(CONSTRAINT|INDEX|KEY)\b/i.test(a)) return;
  if ((m = re(`^RENAME\\s+(?:COLUMN\\s+)?(${IDENT})\\s+TO\\s+(${IDENT})`).exec(a))) {
    return add('column-rename', `${table}.${bare(m[1])}`, `${bare(m[1])} → ${bare(m[2])}`, at);
  }
  if (/^DROP\s+/i.test(a) && !NOT_A_COLUMN.test(a.replace(/^DROP\s+/i, '')) && !/^DROP\s+(DEFAULT|NOT\s+NULL)\b/i.test(a)) {
    m = re(`^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})`).exec(a);
    if (m) return add('column-drop', `${table}.${bare(m[1])}`, `column ${bare(m[1])} dropped`, at);
  }
  if ((m = re(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+([\\s\\S]+?)(?:\\s+USING\\s+([\\s\\S]+))?$`).exec(a))) {
    const column = bare(m[1]);
    add('column-retype', `${table}.${column}`, `type changed to ${oneLine(m[2], 60)}`, at);
    if (m[3] && !isTrivialCast(m[3], column)) {
      add('in-place-conversion', `${table}.${column}`, `values rewritten by USING ${oneLine(m[3], 80)}`, at);
    }
    return;
  }
  if ((m = re(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+SET\\s+NOT\\s+NULL\\b`).exec(a))) {
    return add('not-null', `${table}.${bare(m[1])}`, `${bare(m[1])} SET NOT NULL`, at, 'medium');
  }
  if (re(`^ALTER\\s+(?:COLUMN\\s+)?${IDENT}\\s+(?:SET|DROP|ADD|RESET|RESTART)\\b`).test(a)) return;
  if ((m = re(`^(?:ALTER\\s+COLUMN|MODIFY(?:\\s+COLUMN)?)\\s+(${IDENT})\\s+([A-Za-z][\\s\\S]*)$`).exec(a))) {
    const column = bare(m[1]);
    add('column-retype', `${table}.${column}`, `type restated as ${oneLine(m[2], 60)}`, at);
    if (/\bNOT\s+NULL\b/i.test(m[2])) add('not-null', `${table}.${column}`, `${column} becomes NOT NULL`, at, 'medium');
    return;
  }
  if ((m = re(`^CHANGE\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(${IDENT})\\s+([\\s\\S]+)$`).exec(a))) {
    const from = bare(m[1]);
    const to = bare(m[2]);
    if (from.toLowerCase() !== to.toLowerCase()) add('column-rename', `${table}.${from}`, `${from} → ${to}`, at);
    add('column-retype', `${table}.${from}`, `type restated as ${oneLine(m[3], 60)}`, at, 'medium');
    return;
  }
  if (/^ADD\s+/i.test(a) && !NOT_A_COLUMN.test(a.replace(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i, ''))) {
    m = re(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+([\\s\\S]+)$`).exec(a);
    if (m && /\bNOT\s+NULL\b/i.test(m[2]) && !/\b(DEFAULT|GENERATED|IDENTITY|AUTO_INCREMENT)\b/i.test(m[2])) {
      add('not-null', `${table}.${bare(m[1])}`, `${bare(m[1])} added NOT NULL with no default`, at, 'high');
    }
  }
}

// ---------------------------------------------------------------- Liquibase

const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));

function changeSetsXml(text) {
  return [...text.matchAll(/<changeSet\b([^>]*)>([\s\S]*?)<\/changeSet>/g)].map((m) => {
    const a = attrs(m[1]);
    return {
      key: `${a.author ?? ''}:${a.id ?? ''}`,
      body: m[2],
      offset: m.index + m[0].indexOf('>') + 1,
      mutable: a.runOnChange === 'true' || a.runAlways === 'true',
    };
  });
}

function changeSetsYaml(text) {
  const sets = [];
  let offset = 0;
  let current = null;
  for (const line of text.split('\n')) {
    if (/^\s*-\s*changeSet:\s*$/.test(line)) {
      current = { start: offset + line.length + 1, end: text.length };
      if (sets.length) sets[sets.length - 1].end = offset;
      sets.push(current);
    }
    offset += line.length + 1;
  }
  return sets.map((s) => {
    const body = text.slice(s.start, s.end);
    const id = body.match(/^\s*id:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1] ?? '';
    const author = body.match(/^\s*author:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1] ?? '';
    return { key: `${author}:${id}`, body, offset: s.start, mutable: /^\s*run(OnChange|Always):\s*true\s*$/m.test(body) };
  });
}

function changeSetsFormattedSql(text) {
  const marks = [...text.matchAll(/^--\s*changeset\s+([^\s:]+):(\S+)(.*)$/gim)];
  return marks.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    return { key: `${m[1]}:${m[2]}`, body: text.slice(start, end), offset: start, mutable: /runOnChange:true|runAlways:true/i.test(m[3]) };
  });
}

function changeSetsJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  const sets = [];
  let searchFrom = 0;
  for (const entry of doc.databaseChangeLog ?? []) {
    if (!entry.changeSet) continue;
    const cs = entry.changeSet;
    const idx = text.indexOf('"changeSet"', searchFrom);
    searchFrom = idx + 1;
    sets.push({
      key: `${cs.author ?? ''}:${cs.id ?? ''}`,
      body: JSON.stringify(cs.changes ?? []),
      changes: cs.changes ?? [],
      offset: Math.max(idx, 0),
      mutable: cs.runOnChange === true || cs.runAlways === true,
    });
  }
  return sets;
}

function changeSetsFor(kind, text) {
  if (kind === 'liquibase-xml') return changeSetsXml(text);
  if (kind === 'liquibase-yaml') return changeSetsYaml(text);
  if (kind === 'liquibase-json') return changeSetsJson(text);
  return changeSetsFormattedSql(text);
}

/** One Liquibase change. `columns`: [{ name, value, valueComputed, notNull, hasDefault }]. */
function liquibaseChange(type, a, columns, report) {
  const t = a.tableName ?? '?';
  switch (type) {
    case 'renameColumn':
      report('column-rename', `${t}.${a.oldColumnName}`, `${a.oldColumnName} → ${a.newColumnName}`); break;
    case 'renameTable':
      report('table-rename', a.oldTableName, `${a.oldTableName} → ${a.newTableName}`); break;
    case 'dropColumn':
      for (const c of [a.columnName, ...columns.map((x) => x.name)].filter(Boolean)) report('column-drop', `${t}.${c}`, `column ${c} dropped`);
      break;
    case 'dropTable':
      report('table-drop', t, `table ${t} dropped`); break;
    case 'modifyDataType':
      report('column-retype', `${t}.${a.columnName}`, `type changed to ${a.newDataType}`); break;
    case 'addNotNullConstraint':
      report('not-null', `${t}.${a.columnName}`, `${a.columnName} becomes NOT NULL${a.defaultNullValue ? ` (nulls set to ${a.defaultNullValue})` : ''}`, 'medium'); break;
    case 'addColumn':
      for (const c of columns) if (c.notNull && !c.hasDefault) report('not-null', `${t}.${c.name}`, `${c.name} added NOT NULL with no default`, 'high');
      break;
    case 'update':
      for (const c of columns) {
        if (c.valueComputed && referencesColumn(c.valueComputed, c.name)) {
          report('in-place-conversion', `${t}.${c.name}`, `values rewritten in place: ${c.name} = ${c.valueComputed}`);
        } else {
          report('backfill', `${t}.${c.name}`, `${c.name} filled from ${c.valueComputed ?? c.value ?? '?'}`);
        }
      }
      break;
    case 'delete':
      report('row-delete', t, `rows deleted from ${t}`); break;
    default: break;
  }
}

const LB_TYPES = 'renameColumn|renameTable|dropColumn|dropTable|modifyDataType|addNotNullConstraint|addColumn|update|delete|sql';

function scanLiquibaseXml(body, bodyOffset, ctx) {
  const tag = new RegExp(`<(${LB_TYPES})\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/\\1>)`, 'g');
  for (const m of body.matchAll(tag)) {
    const at = bodyOffset + m.index;
    const inner = m[4] ?? '';
    if (m[1] === 'sql') {
      const sql = inner.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
      ctx.sql(sql, at + m[0].indexOf('>') + 1 + inner.indexOf(sql));
      continue;
    }
    const columns = [...inner.matchAll(/<column\b([^>]*?)(\/>|>([\s\S]*?)<\/column>)/g)].map((c) => {
      const ca = attrs(c[1]);
      return {
        name: ca.name,
        value: ca.value,
        valueComputed: ca.valueComputed,
        notNull: /nullable\s*=\s*"false"/.test(c[3] ?? ''),
        hasDefault: Object.keys(ca).some((k) => k.startsWith('defaultValue')),
      };
    });
    liquibaseChange(m[1], attrs(m[2]), columns, ctx.at(at));
  }
}

function yamlScalars(block) {
  const out = {};
  for (const m of block.matchAll(/^\s*-?\s*(\w+):\s*["']?([^"'\n]*?)["']?\s*$/gm)) if (m[2] !== '') out[m[1]] ??= m[2];
  return out;
}

function scanLiquibaseYaml(body, bodyOffset, ctx) {
  const lines = body.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; offset += lines[i].length + 1, i++) {
    const m = lines[i].match(new RegExp(`^(\\s*)-?\\s*(${LB_TYPES}):\\s*(.*)$`));
    if (!m) continue;
    const indent = lines[i].search(/\S/);
    const block = [];
    const blockStart = offset + lines[i].length + 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
      block.push(lines[j]);
    }
    const text = block.join('\n');
    const at = bodyOffset + offset;
    if (m[2] === 'sql') {
      if (!m[3]) continue; // `- sql:` object; its nested `sql:` key is matched on its own line
      if (/^[|>]/.test(m[3])) ctx.sql(text, bodyOffset + blockStart);
      else ctx.sql(m[3].replace(/^["']|["']$/g, ''), at + lines[i].indexOf(m[3]));
      continue;
    }
    const columns = text.split(/^\s*-\s*column:\s*$/m).slice(1).map((cb) => {
      const ca = yamlScalars(cb);
      return { name: ca.name, value: ca.value, valueComputed: ca.valueComputed, notNull: /nullable:\s*false/.test(cb), hasDefault: /defaultValue\w*:/.test(cb) };
    });
    const a = yamlScalars(text.split(/^\s*-\s*column:\s*$/m)[0]);
    liquibaseChange(m[2], a, columns, ctx.at(at));
  }
}

function scanLiquibaseJson(changes, at, ctx) {
  for (const change of changes) {
    for (const [type, spec] of Object.entries(change)) {
      if (type === 'sql') {
        const sql = typeof spec === 'string' ? spec : spec?.sql ?? '';
        for (const f of scanSql(sql, { file: ctx.file })) ctx.push({ ...f, line: lineAt(ctx.fileText, at) });
        continue;
      }
      const columns = (spec?.columns ?? []).map((c) => c.column ?? c).map((c) => ({
        name: c.name,
        value: c.value,
        valueComputed: c.valueComputed,
        notNull: c.constraints?.nullable === false,
        hasDefault: Object.keys(c).some((k) => k.startsWith('defaultValue')),
      }));
      liquibaseChange(type, spec ?? {}, columns, ctx.at(at));
    }
  }
}

// ---------------------------------------------------------------- EF Core

function matchBrace(text, open) {
  let depth = 0;
  let state = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (state === 'line') { if (c === '\n') state = null; continue; }
    if (state === 'block') { if (c === '*' && text[i + 1] === '/') { state = null; i++; } continue; }
    if (state === '"') { if (c === '\\') i++; else if (c === '"') state = null; continue; }
    if (state === '@"') { if (c === '"') { if (text[i + 1] === '"') i++; else state = null; } continue; }
    if (c === '/' && text[i + 1] === '/') { state = 'line'; continue; }
    if (c === '/' && text[i + 1] === '*') { state = 'block'; continue; }
    if (c === '@' && text[i + 1] === '"') { state = '@"'; i++; continue; }
    if (c === '"') { state = '"'; continue; }
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function csString(lit) {
  const s = lit.trim();
  if (s.startsWith('@"')) return s.slice(2, -1).replace(/""/g, '"');
  if (s.startsWith('"""')) return s.replace(/^"""[ \t]*\n?/, '').replace(/\n?[ \t]*"""$/, '');
  if (s.startsWith('"')) return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["\\])/g, '$1');
  return s;
}

function csArgs(argText) {
  const out = { _: [] };
  for (const part of splitTopLevel(argText)) {
    const m = part.text.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    const value = (m ? m[2] : part.text).trim();
    const parsed = /^(@?"|""")/.test(value) ? csString(value) : value.replace(/^typeof\((.+)\)$/, '$1');
    if (m) out[m[1]] = parsed; else out._.push(parsed);
  }
  return out;
}

const CS_TYPES = { long: 'int64', int: 'int32', short: 'int16', decimal: 'decimal', double: 'double', float: 'single', string: 'string', bool: 'boolean', byte: 'byte', guid: 'guid', datetime: 'datetime', datetimeoffset: 'datetimeoffset' };
const clrType = (t) => {
  const k = String(t ?? '').replace(/\?$/, '').replace(/^System\./, '').toLowerCase();
  return CS_TYPES[k] ?? k;
};

/** migrationBuilder calls inside Up() only; Down() is the reverse and would give false alarms. */
export function efCalls(text) {
  const up = /void\s+Up\s*\(\s*MigrationBuilder\s+\w+\s*\)\s*\{/.exec(text);
  if (!up) return [];
  const open = up.index + up[0].length - 1;
  const close = matchBrace(text, open);
  const body = text.slice(open, close === -1 ? text.length : close);
  const calls = [];
  const call = /\b\w+\s*\.\s*(RenameColumn|RenameTable|DropColumn|DropTable|AlterColumn|AddColumn|Sql|DeleteData|UpdateData)\s*(?:<([^>]*)>)?\s*\(/g;
  for (const m of body.matchAll(call)) {
    const parenAt = m.index + m[0].length - 1;
    const end = matchBrace(body, parenAt);
    if (end === -1) continue;
    const argText = body.slice(parenAt + 1, end);
    calls.push({ method: m[1], generic: m[2], args: csArgs(argText), offset: open + m.index, norm: (m[0] + argText).replace(/\s+/g, ' ') });
  }
  return calls;
}

function scanEf(text, ctx, skip) {
  for (const c of efCalls(text)) {
    if (skip?.has(c.norm)) continue;
    const a = c.args;
    const report = ctx.at(c.offset);
    switch (c.method) {
      case 'RenameColumn': report('column-rename', `${a.table}.${a.name}`, `${a.name} → ${a.newName}`); break;
      case 'RenameTable': report('table-rename', a.name, `${a.name} → ${a.newName}`); break;
      case 'DropColumn': report('column-drop', `${a.table}.${a.name}`, `column ${a.name} dropped`); break;
      case 'DropTable': report('table-drop', a.name, `table ${a.name} dropped`); break;
      case 'AlterColumn': {
        const typeChanged = (a.type && a.oldType && a.type !== a.oldType)
          || (c.generic && a.oldClrType && clrType(c.generic) !== clrType(a.oldClrType));
        if (typeChanged) report('column-retype', `${a.table}.${a.name}`, `type ${a.oldType ?? a.oldClrType} → ${a.type ?? c.generic}`);
        if (String(a.nullable) === 'false' && String(a.oldNullable) === 'true') report('not-null', `${a.table}.${a.name}`, `${a.name} becomes NOT NULL`, 'medium');
        break;
      }
      case 'AddColumn':
        if (String(a.nullable) === 'false' && !('defaultValue' in a) && !('defaultValueSql' in a) && !('computedColumnSql' in a)) {
          report('not-null', `${a.table}.${a.name}`, `${a.name} added NOT NULL with no default`, 'high');
        }
        break;
      case 'Sql':
        for (const f of scanSql(a._[0] ?? a.sql ?? '', { file: ctx.file })) ctx.push({ ...f, line: lineAt(text, c.offset) });
        break;
      case 'DeleteData': report('row-delete', a.table, `rows deleted from ${a.table}`); break;
      case 'UpdateData': report('backfill', `${a.table}.${a.column ?? '?'}`, `${a.column ?? 'columns'} set by UpdateData`); break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------- per-file scan

function firstChangedLine(range, file) {
  const args = ['diff', '-U0', range.mergeBase];
  if (!range.worktree) args.push(range.headCommit);
  args.push('--', file);
  const out = git(range.root, args, { allowFail: true }).stdout;
  const m = out.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  return m ? Math.max(Number(m[1]), 1) : 1;
}

export function scanFile({ file, kind, prefix, headText, baseText, status, range }) {
  const findings = [];
  const fileText = headText ?? '';
  const ctx = {
    file,
    fileText,
    push: (f) => findings.push(f),
    at: (offset) => (pattern, object, detail, severity = SEVERITY[pattern]) =>
      findings.push({ file, line: lineAt(fileText, offset), pattern, object, severity, detail }),
    sql: (sql, offset) => findings.push(...scanSql(sql, { file, fileText, offset })),
  };
  const edited = (line, object, detail) =>
    findings.push({ file, line, pattern: 'applied-migration-edited', object, severity: 'high', detail });

  const existedBefore = baseText != null;
  const repeatable = kind === 'flyway' && prefix === 'R';
  if (kind === 'flyway' && prefix === 'U') return findings; // undo scripts only run on demand

  if (status === 'D') {
    if (!repeatable) edited(1, file.split('/').pop(), 'migration deleted after it was applied');
    return findings;
  }

  if (kind.startsWith('liquibase')) {
    const before = new Map((existedBefore ? changeSetsFor(kind, baseText) : []).map((s) => [s.key, s]));
    for (const cs of changeSetsFor(kind, headText)) {
      const old = before.get(cs.key);
      if (old) {
        if (old.body.replace(/\s+/g, ' ').trim() === cs.body.replace(/\s+/g, ' ').trim()) continue;
        if (!cs.mutable) edited(lineAt(fileText, cs.offset), `changeSet ${cs.key}`, 'changeSet edited after it was applied');
      }
      if (kind === 'liquibase-xml') scanLiquibaseXml(cs.body, cs.offset, ctx);
      else if (kind === 'liquibase-yaml') scanLiquibaseYaml(cs.body, cs.offset, ctx);
      else if (kind === 'liquibase-json') scanLiquibaseJson(cs.changes, cs.offset, ctx);
      else ctx.sql(cs.body, cs.offset);
    }
    return findings;
  }

  if (existedBefore && !repeatable && status !== 'A') {
    edited(firstChangedLine(range, file), file.split('/').pop(),
      'migration edited after it was applied; environments that already ran it will never run this version');
  }

  if (kind === 'ef-core') {
    scanEf(headText, ctx, existedBefore ? new Set(efCalls(baseText).map((c) => c.norm)) : null);
    return findings;
  }

  const skip = existedBefore ? new Set(splitSql(baseText).map((s) => normaliseStatement(s.text))) : null;
  findings.push(...scanSql(headText, { file, skip }));
  return findings;
}

// ---------------------------------------------------------------- main

function main(argv) {
  const args = parseArgs(argv, { flags: ['worktree'] });
  if (!args.base) throw new Error('--base is required (see --help)');
  const range = resolveRange({ repo: args.repo ?? process.cwd(), base: args.base, head: args.head ?? 'HEAD', worktree: !!args.worktree });
  const migrations = [];
  const findings = [];
  const errors = [];

  for (const f of changedFiles(range)) {
    try {
      const headText = f.status === 'D' ? null : readSide(range, 'head', f.path);
      const baseText = readSide(range, 'base', f.oldPath ?? f.path);
      const cls = classify(f.path, headText ?? baseText);
      if (!cls) continue;
      migrations.push({ file: f.path, status: f.status, kind: cls.kind, version: cls.version ?? null, ...(f.oldPath ? { renamedFrom: f.oldPath } : {}) });
      const fileFindings = scanFile({ file: f.path, kind: cls.kind, prefix: cls.prefix, headText, baseText, status: f.status, range });
      const lines = (headText ?? '').split('\n');
      for (const x of fileFindings) {
        x.statement ??= (lines[x.line - 1] ?? '').trim().slice(0, 200);
        findings.push(x);
      }
    } catch (err) {
      errors.push(`${f.path}: ${err.message}`);
    }
  }

  return {
    tool: 'scan-migrations',
    version: 1,
    base: range.base,
    head: range.head,
    mergeBase: range.mergeBase,
    migrations,
    findings: sortFindings(findings),
    summary: summarise(findings),
    errors,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('scan-migrations.mjs')) {
  run('scan-migrations', main, HELP);
}
