// The generated plugin package (plugins/one-way-door) is valid, in sync with the in-repo sources,
// and its hook works with ${PLUGIN_ROOT} set and fails open without it.
// Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins/one-way-door');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
delete GIT_ENV.PLUGIN_ROOT;
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('the committed package matches the sources (node tools/build-plugin.mjs --check)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/build-plugin.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('plugin.json follows the Agent Plugins 1.0 manifest schema', () => {
  const manifest = json(path.join(PLUGIN, 'plugin.json'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(manifest.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.ok(manifest.name.length <= 64);
  const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  for (const key of Object.keys(manifest)) assert.ok(allowed.includes(key), `plugin.json may not contain ${key}`);
});

test('the skill sits at skills/<name>/SKILL.md with a matching name', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills/one-way-door/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: one-way-door\n/);
  assert.ok(!fs.existsSync(path.join(PLUGIN, 'skills/one-way-door/scripts/test')), 'tests are not shipped');
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'skills/one-way-door/scripts/scan-migrations.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage/);
});

test('the marketplace entry points at the plugin', () => {
  const market = json(path.join(ROOT, '.github/plugin/marketplace.json'));
  const entry = market.plugins.find((p) => p.name === 'one-way-door');
  assert.ok(entry);
  assert.ok(fs.existsSync(path.join(ROOT, entry.source, 'plugin.json')));
  assert.equal(entry.version, json(path.join(PLUGIN, 'plugin.json')).version);
});

test('the plugin hook denies with PLUGIN_ROOT set and allows when it is missing', () => {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'owd-plugin-hook-')));
  temps.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV });
  fs.mkdirSync(path.join(repo, 'db/migration'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'db/migration/V1__init.sql'), 'CREATE TABLE t (id int);\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  const [entry] = json(path.join(PLUGIN, 'com.github.copilot/hooks/hooks.json')).hooks.preToolUse;
  const input = JSON.stringify({ toolName: 'edit', toolArgs: { path: 'db/migration/V1__init.sql' }, cwd: repo });
  const run = (env) => spawnSync('bash', ['-c', entry.bash], { input, cwd: repo, encoding: 'utf8', env: { ...GIT_ENV, ...env } });

  const withRoot = run({ PLUGIN_ROOT: PLUGIN });
  assert.equal(withRoot.status, 0);
  assert.equal(JSON.parse(withRoot.stdout).permissionDecision, 'deny');

  const without = run({});
  assert.equal(without.status, 0);
  assert.deepEqual(JSON.parse(without.stdout), {});
});
