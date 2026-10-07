#!/usr/bin/env node
// Builds plugins/one-way-door (an Agent Plugins 1.0 package for VS Code, Copilot CLI and the Copilot app)
// from the in-repo sources of truth:
//   .github/skills/one-way-door/            -> skills/one-way-door/
//   .github/hooks/scripts/deny-applied-…    -> com.github.copilot/hooks/scripts/
//   (generated)                             -> plugin.json, com.github.copilot/hooks/hooks.json, README.md, LICENSE
//
// Usage: node tools/build-plugin.mjs           write the package
//        node tools/build-plugin.mjs --check   exit 1 if the committed package is out of date
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'plugins/one-way-door');
const VERSION = '1.0.0';
const NAME = 'one-way-door';
const DESCRIPTION = 'Rollback-safety review for pull requests: finds one-way doors (migrations, event schema changes, '
  + 'caches, webhooks) that the previous release can\'t survive, and proposes an expand/migrate/contract/drop split.';

const HOOK_SCRIPT = 'deny-applied-migration-edit';

function copyTree(from, to, skip = () => false) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skip(src)) continue;
    if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyTree(src, dst, skip); }
    else { fs.copyFileSync(src, dst); fs.chmodSync(dst, fs.statSync(src).mode); }
  }
}

function build(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // Portable core: the skill, minus its test suite.
  const skillSrc = path.join(ROOT, '.github/skills/one-way-door');
  const skillDst = path.join(out, 'skills/one-way-door');
  fs.mkdirSync(skillDst, { recursive: true });
  copyTree(skillSrc, skillDst, (p) => p === path.join(skillSrc, 'scripts/test'));

  // Copilot extension: the preToolUse hook.
  const hooksDst = path.join(out, 'com.github.copilot/hooks');
  fs.mkdirSync(path.join(hooksDst, 'scripts'), { recursive: true });
  for (const ext of ['sh', 'ps1']) {
    const src = path.join(ROOT, `.github/hooks/scripts/${HOOK_SCRIPT}.${ext}`);
    const dst = path.join(hooksDst, `scripts/${HOOK_SCRIPT}.${ext}`);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, fs.statSync(src).mode);
  }
  // ${PLUGIN_ROOT} is expanded by VS Code. If a client doesn't expand it and doesn't set it either,
  // the path won't exist and the command allows ({}), so a missing variable never blocks every tool.
  const script = `\${PLUGIN_ROOT}/com.github.copilot/hooks/scripts/${HOOK_SCRIPT}`;
  write(path.join(hooksDst, 'hooks.json'), {
    version: 1,
    hooks: {
      preToolUse: [{
        type: 'command',
        bash: `f="${script}.sh"; if [ -f "$f" ]; then bash "$f"; else cat >/dev/null; echo '{}'; fi`,
        powershell: `$r = '\${PLUGIN_ROOT}'; if ($env:PLUGIN_ROOT) { $r = $env:PLUGIN_ROOT }; `
          + `$f = "$r/com.github.copilot/hooks/scripts/${HOOK_SCRIPT}.ps1"; if (Test-Path $f) { & $f } else { '{}' }`,
        timeoutSec: 10,
      }],
    },
  });

  write(path.join(out, 'plugin.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
    license: 'MIT',
    keywords: ['rollback', 'migrations', 'flyway', 'liquibase', 'ef-core', 'kafka', 'json-schema', 'pull-request', 'review', 'expand-contract'],
  });

  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'));
  fs.writeFileSync(path.join(out, 'README.md'), README);
}

function write(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function listTree(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listTree(p, base) : [path.relative(base, p)];
  }).sort();
}

function diffTrees(a, b) {
  const left = listTree(a);
  const right = listTree(b);
  const problems = [];
  for (const f of new Set([...left, ...right])) {
    if (!left.includes(f)) problems.push(`missing: ${f}`);
    else if (!right.includes(f)) problems.push(`unexpected: ${f}`);
    else if (!fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))) problems.push(`out of date: ${f}`);
  }
  return problems;
}

const README = `# one-way-door (Copilot plugin)

**Generated from \`.github/skills/one-way-door\` and \`.github/hooks\` by \`tools/build-plugin.mjs\`. Don't edit it here.**

Rollback-safety review for pull requests. It answers the question no pipeline asks: *"If this goes wrong after
deploy, can we actually roll back?"*

## What you get

- **Skill \`one-way-door\`.** Reviews a diff, classifies each change as one-way or two-way, says when the door closes
  and what breaks on rollback, finds the blast radius, and proposes an expand → migrate → contract → drop split.
  It brings two offline Node scripts (\`scan-migrations.mjs\`, \`schema-compat.mjs\`).
- **preToolUse hook.** Stops the agent editing a database migration that is already on the default branch.

## Install

Copilot CLI:

\`\`\`bash
copilot plugin install OWNER/REPO:plugins/one-way-door
\`\`\`

or, through this repo's marketplace (\`.github/plugin/marketplace.json\`):

\`\`\`bash
copilot plugin marketplace add OWNER/REPO
copilot plugin install one-way-door@one-way-door
\`\`\`

VS Code: set \`"chat.plugins.enabled": true\`, run **Chat: Install Plugin From Source**, and give it the repository URL.
For a local checkout, add the folder to \`chat.pluginLocations\`.

The Copilot cloud agent doesn't load plugins. For the cloud agent, copy \`.github/skills/one-way-door\` (and
optionally \`.github/hooks\`) into the repository instead.

## Use

Ask: *"Review this PR for rollback safety"*, *"Can we roll back main...my-branch?"*, or *"/one-way-door"*.
Node.js 20+ runs the scripts. Without it, the skill falls back to reading the diff.
`;

const check = process.argv.includes('--check');
if (check) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owd-plugin-'));
  build(tmp);
  const problems = diffTrees(tmp, OUT);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (problems.length) {
    console.error(`plugins/one-way-door is out of date (run: node tools/build-plugin.mjs):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('plugins/one-way-door is up to date');
} else {
  build(OUT);
  console.log(`built ${path.relative(ROOT, OUT)} (${listTree(OUT).length} files)`);
}
