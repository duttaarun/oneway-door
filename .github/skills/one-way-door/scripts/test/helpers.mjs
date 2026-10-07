// Test helpers: throwaway git repositories and a runner for the scripts.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Creates a temp repo on `main` with one commit holding `files`. */
export function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owd-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  const repo = {
    dir,
    git,
    write(more) {
      for (const [p, content] of Object.entries(more)) {
        const abs = path.join(dir, p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      return repo;
    },
    remove(...paths) {
      for (const p of paths) fs.rmSync(path.join(dir, p));
      return repo;
    },
    commit(message = 'change') {
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
      return repo;
    },
    branch(name) { git('switch', '-q', '-c', name); return repo; },
    checkout(name) { git('switch', '-q', name); return repo; },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return repo.write(files).commit('base');
}

/** Runs a script and parses its JSON. */
export function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: GIT_ENV });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

export const scan = (repo, ...extra) => run('scan-migrations.mjs', ['--repo', repo.dir, '--base', 'main', '--head', 'feature', ...extra]);
export const compat = (repo, ...extra) => run('schema-compat.mjs', ['--repo', repo.dir, '--base', 'main', '--head', 'feature', ...extra]);

/** "pattern object" strings, sorted, for compact assertions. */
export const found = (json) => json.findings.map((f) => `${f.pattern} ${f.object}`).sort();
export const find = (json, pattern, object) => json.findings.find((f) => f.pattern === pattern && (!object || f.object === object));
