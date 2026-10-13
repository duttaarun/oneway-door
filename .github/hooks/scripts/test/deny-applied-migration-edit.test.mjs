// Pipes sample preToolUse payloads (Copilot and VS Code shapes) into the hook scripts.
// Runs the bash script always, and the PowerShell twin when `pwsh` is on PATH.
// Run: node --test .github/hooks/scripts/test/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SH = path.join(HOOKS, 'scripts/deny-applied-migration-edit.sh');
const PS1 = path.join(HOOKS, 'scripts/deny-applied-migration-edit.ps1');
const HOOK_JSON = JSON.parse(fs.readFileSync(path.join(HOOKS, 'one-way-door.json'), 'utf8'));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
delete GIT_ENV.ONE_WAY_DOOR_BASE;

const MIG = 'svc/src/main/resources/db/migration';
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

let repo;
let outside;
before(() => {
  // realpath: macOS temp folders sit behind /private, and Windows may hand out 8.3 short names (RUNNER~1).
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'owd-hook-')));
  outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'owd-nogit-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV });
  const write = (p, c) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  write(`${MIG}/V1__init.sql`, 'CREATE TABLE t (id int);\n');
  write(`${MIG}/V2__index.sql`, 'CREATE INDEX t_id ON t (id);\n');
  write(`${MIG}/R__views.sql`, 'CREATE OR REPLACE VIEW v AS SELECT 1;\n');
  write('src/Ledger/Migrations/20260101_Init.cs', 'class Init {}\n');
  write('src/Ledger/Migrations/20260101_Init.Designer.cs', 'class InitDesigner {}\n');
  write('db/changelog/master.xml', '<databaseChangeLog/>\n');
  write('src/App.java', 'class App {}\n');
  fs.cpSync(HOOKS, path.join(repo, '.github/hooks'), { recursive: true });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feature');
  write(`${MIG}/V3__new.sql`, 'ALTER TABLE t ADD COLUMN c int;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
});
after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const copilot = (toolName, toolArgs, cwd = repo) =>
  JSON.stringify({ sessionId: 's1', timestamp: 1760000000000, cwd, toolName, toolArgs });
const vscode = (tool_name, tool_input, cwd = repo) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', timestamp: '2026-10-07T12:00:00Z', cwd, tool_name, tool_input, tool_use_id: 't1' });

const runners = [['bash', (input, { cwd = repo, env = {} } = {}) => spawnSync('bash', [SH], { input, cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env } })]];
if (hasPwsh) {
  runners.push(['pwsh', (input, { cwd = repo, env = {} } = {}) => spawnSync('pwsh', ['-NoProfile', '-File', PS1], { input, cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env } })]);
}

function decide(runner, input, opts) {
  const r = runner(input, opts);
  assert.equal(r.status, 0, `hook must always exit 0 (stderr: ${r.stderr})`);
  const out = JSON.parse(r.stdout.trim());
  if (out.permissionDecision === 'deny') {
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, out.permissionDecisionReason);
    assert.match(out.permissionDecisionReason, /^one-way-door: /);
    return { decision: 'deny', reason: out.permissionDecisionReason };
  }
  assert.deepEqual(out, {}, 'allow must be {}');
  return { decision: 'allow' };
}

for (const [name, runner] of runners) {
  describe(`preToolUse hook (${name})`, () => {
    test('Copilot edit of an applied Flyway migration is denied, with a next-version hint', () => {
      const d = decide(runner, copilot('edit', { path: `${MIG}/V1__init.sql`, old_str: 'int', new_str: 'bigint' }));
      assert.equal(d.decision, 'deny');
      assert.match(d.reason, /V1__init\.sql is already on main/);
      assert.match(d.reason, /V3__<what_changes>\.sql/);
    });

    test('VS Code shape with an absolute path is denied', () => {
      const d = decide(runner, vscode('Edit', { file_path: path.join(repo, MIG, 'V2__index.sql'), old_string: 'a', new_string: 'b' }));
      assert.equal(d.decision, 'deny');
    });

    test('Windows-style paths are denied: backslashes, other letter case, file URIs', () => {
      const abs = path.join(repo, MIG, 'V1__init.sql');
      assert.equal(decide(runner, vscode('Edit', { file_path: abs.replace(/\//g, '\\') })).decision, 'deny');
      // Editors may spell the root differently from git (c: vs C:); the path inside the repo keeps its case.
      assert.equal(decide(runner, vscode('Edit', { file_path: path.join(repo.toUpperCase(), MIG, 'V1__init.sql') })).decision, 'deny');
      assert.equal(decide(runner, copilot('edit', { path: `file://${abs}` })).decision, 'deny');
    });

    test('a file list containing one applied migration is denied', () => {
      assert.equal(decide(runner, vscode('editFiles', { files: ['src/App.java', `${MIG}/V1__init.sql`] })).decision, 'deny');
    });

    test('apply_patch touching an applied migration is denied', () => {
      const patch = `*** Begin Patch\n*** Update File: ${MIG}/V2__index.sql\n@@\n-CREATE INDEX\n+CREATE UNIQUE INDEX\n*** End Patch`;
      assert.equal(decide(runner, copilot('apply_patch', { input: patch })).decision, 'deny');
    });

    test('toolArgs sent as a JSON string is still understood', () => {
      assert.equal(decide(runner, copilot('edit', JSON.stringify({ path: `${MIG}/V1__init.sql` }))).decision, 'deny');
    });

    test('EF Core migration classes are protected, Designer files are not', () => {
      assert.equal(decide(runner, copilot('edit', { path: 'src/Ledger/Migrations/20260101_Init.cs' })).decision, 'deny');
      assert.equal(decide(runner, copilot('edit', { path: 'src/Ledger/Migrations/20260101_Init.Designer.cs' })).decision, 'allow');
    });

    test('new migrations, migrations only on this branch, repeatable ones and Liquibase changelogs are allowed', () => {
      assert.equal(decide(runner, copilot('create', { path: `${MIG}/V4__more.sql`, file_text: 'SELECT 1;' })).decision, 'allow');
      assert.equal(decide(runner, copilot('edit', { path: `${MIG}/V3__new.sql` })).decision, 'allow');
      assert.equal(decide(runner, copilot('edit', { path: `${MIG}/R__views.sql` })).decision, 'allow');
      assert.equal(decide(runner, copilot('edit', { path: 'db/changelog/master.xml' })).decision, 'allow');
    });

    test('reading an applied migration and editing other code are allowed', () => {
      assert.equal(decide(runner, copilot('view', { path: `${MIG}/V1__init.sql` })).decision, 'allow');
      assert.equal(decide(runner, vscode('Read', { file_path: `${MIG}/V1__init.sql` })).decision, 'allow');
      assert.equal(decide(runner, copilot('str_replace_editor', { command: 'view', path: `${MIG}/V1__init.sql` })).decision, 'allow');
      assert.equal(decide(runner, copilot('edit', { path: 'src/App.java' })).decision, 'allow');
    });

    test('shell commands: writing to an applied migration is denied, reading is allowed', () => {
      assert.equal(decide(runner, copilot('bash', { command: `sed -i 's/int/bigint/' ${MIG}/V1__init.sql` })).decision, 'deny');
      assert.equal(decide(runner, copilot('bash', { command: `rm ${MIG}/V2__index.sql` })).decision, 'deny');
      assert.equal(decide(runner, vscode('Bash', { command: `echo "-- note" >> ${MIG}/V1__init.sql` })).decision, 'deny');
      assert.equal(decide(runner, copilot('bash', { command: `cat ${MIG}/V1__init.sql 2>/dev/null` })).decision, 'allow');
      assert.equal(decide(runner, copilot('bash', { command: 'ls > listing.txt' })).decision, 'allow');
    });

    test('ONE_WAY_DOOR_BASE overrides the default branch', () => {
      const d = decide(runner, copilot('edit', { path: `${MIG}/V3__new.sql` }), { env: { ONE_WAY_DOOR_BASE: 'feature' } });
      assert.equal(d.decision, 'deny');
      assert.match(d.reason, /already on feature/);
    });

    test('fails open: bad JSON, empty input, unknown tools, no git repo', () => {
      assert.equal(decide(runner, 'not json at all').decision, 'allow');
      assert.equal(decide(runner, '').decision, 'allow');
      assert.equal(decide(runner, copilot('web_fetch', { url: 'https://example.invalid' })).decision, 'allow');
      assert.equal(decide(runner, copilot('edit', { path: 'V1__init.sql' }, outside), { cwd: outside }).decision, 'allow');
    });
  });
}

describe('one-way-door.json wiring', () => {
  test('uses the documented Copilot hook format', () => {
    assert.equal(HOOK_JSON.version, 1);
    const [entry] = HOOK_JSON.hooks.preToolUse;
    assert.equal(entry.type, 'command');
    assert.ok(entry.bash && entry.powershell);
    assert.ok(entry.timeoutSec > 0 && entry.timeoutSec <= 30);
  });

  test('the bash command, run from the repo root, denies an applied-migration edit', () => {
    const r = spawnSync('bash', ['-c', HOOK_JSON.hooks.preToolUse[0].bash], {
      input: copilot('edit', { path: `${MIG}/V1__init.sql` }), cwd: repo, encoding: 'utf8', env: GIT_ENV,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny');
  });

  test('the bash command allows everything if the script is missing (never blocks all tools)', () => {
    const r = spawnSync('bash', ['-c', HOOK_JSON.hooks.preToolUse[0].bash], {
      input: copilot('edit', { path: `${MIG}/V1__init.sql` }), cwd: outside, encoding: 'utf8', env: GIT_ENV,
    });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), {});
  });

  test('PowerShell twin', { skip: hasPwsh ? false : 'pwsh is not installed; run in the PowerShell container (see docs)' }, () => {
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', HOOK_JSON.hooks.preToolUse[0].powershell], {
      input: copilot('edit', { path: `${MIG}/V1__init.sql` }), cwd: repo, encoding: 'utf8', env: GIT_ENV,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny');
  });
});
