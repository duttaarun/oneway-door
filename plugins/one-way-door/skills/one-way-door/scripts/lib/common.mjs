// Shared helpers for the one-way-door scripts. Node 20+, standard library only, no network.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

/**
 * Minimal argument parser: --key value, --key=value, --flag. Repeated keys listed in `multi` become arrays.
 */
export function parseArgs(argv, { flags = [], multi = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    let [key, value] = arg.slice(2).split(/=(.*)/s, 2);
    if (flags.includes(key)) { out[key] = true; continue; }
    if (value === undefined) value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (multi.includes(key)) (out[key] ??= []).push(value);
    else out[key] = value;
  }
  return out;
}

export function git(repo, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim().split('\n')[0]}`);
  }
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Resolves base/head to commits and finds the merge base, so only the branch's own changes count. */
export function resolveRange({ repo, base, head = 'HEAD', worktree = false }) {
  const top = git(repo, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top.ok) throw new Error(`not a git repository: ${repo}`);
  const root = top.stdout.trim();
  const commit = (ref) => {
    const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    if (!r.ok) throw new Error(`unknown ref "${ref}" (fetch it first, e.g. git fetch origin ${ref})`);
    return r.stdout.trim();
  };
  const baseCommit = commit(base);
  const headCommit = commit(head);
  const mb = git(root, ['merge-base', baseCommit, headCommit], { allowFail: true });
  return {
    root,
    base,
    head: worktree ? 'WORKTREE' : head,
    baseCommit,
    headCommit,
    mergeBase: mb.ok ? mb.stdout.trim() : baseCommit,
    worktree,
  };
}

/** Changed files between the merge base and head (or the working tree), with renames detected. */
export function changedFiles(range) {
  const args = ['diff', '--name-status', '-z', '-M', range.mergeBase];
  if (!range.worktree) args.push(range.headCommit);
  const tokens = git(range.root, args).stdout.split('\0').filter((t) => t !== '');
  const files = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    const code = status[0];
    if (code === 'R' || code === 'C') {
      files.push({ status: code, oldPath: tokens[i++], path: tokens[i++] });
    } else {
      files.push({ status: code, path: tokens[i++], oldPath: null });
    }
  }
  if (range.worktree) {
    const untracked = git(range.root, ['ls-files', '-z', '--others', '--exclude-standard']).stdout;
    for (const p of untracked.split('\0').filter(Boolean)) files.push({ status: 'A', path: p, oldPath: null });
  }
  return files;
}

/** File contents at the merge base (side 'base') or at head / in the working tree (side 'head'). */
export function readSide(range, side, filePath) {
  if (filePath == null) return null;
  if (side === 'head' && range.worktree) {
    const abs = path.join(range.root, filePath);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  }
  const ref = side === 'base' ? range.mergeBase : range.headCommit;
  const r = git(range.root, ['show', `${ref}:${filePath}`], { allowFail: true });
  return r.ok ? r.stdout : null;
}

export function listFilesAt(range, side, dir) {
  if (side === 'head' && range.worktree) {
    const r = git(range.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir]);
    return r.stdout.split('\0').filter(Boolean).filter((p) => fs.existsSync(path.join(range.root, p)));
  }
  const ref = side === 'base' ? range.mergeBase : range.headCommit;
  const r = git(range.root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', dir], { allowFail: true });
  return r.ok ? r.stdout.split('\0').filter(Boolean) : [];
}

/** 1-based line number of a character offset. */
export function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function sortFindings(findings) {
  return findings.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    || a.file.localeCompare(b.file)
    || (a.line ?? 0) - (b.line ?? 0));
}

export function summarise(findings) {
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0 };
  const byPattern = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
  }
  return { total: findings.length, bySeverity, byPattern };
}

/** Prints JSON and always exits 0: findings are data, not errors. */
export function run(tool, main, help) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(help);
    process.exitCode = 0;
    return;
  }
  let result;
  try {
    result = main(argv);
  } catch (err) {
    result = { tool, version: 1, findings: [], summary: summarise([]), errors: [String(err?.message ?? err)] };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = 0;
}
