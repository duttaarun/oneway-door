# one-way-door (Copilot plugin)

**Generated from `.github/skills/one-way-door` and `.github/hooks` by `tools/build-plugin.mjs`. Don't edit it here.**

Rollback-safety review for pull requests. It answers the question no pipeline asks: *"If this goes wrong after
deploy, can we actually roll back?"*

## What you get

- **Skill `one-way-door`.** Reviews a diff, classifies each change as one-way or two-way, says when the door closes
  and what breaks on rollback, finds the blast radius, and proposes an expand → migrate → contract → drop split.
  It brings two offline Node scripts (`scan-migrations.mjs`, `schema-compat.mjs`).
- **preToolUse hook.** Stops the agent editing a database migration that is already on the default branch.

## Install

Copilot CLI:

```bash
copilot plugin install OWNER/REPO:plugins/one-way-door
```

or, through this repo's marketplace (`.github/plugin/marketplace.json`):

```bash
copilot plugin marketplace add OWNER/REPO
copilot plugin install one-way-door@one-way-door
```

VS Code: set `"chat.plugins.enabled": true`, run **Chat: Install Plugin From Source**, and give it the repository URL.
For a local checkout, add the folder to `chat.pluginLocations`.

The Copilot cloud agent doesn't load plugins. For the cloud agent, copy `.github/skills/one-way-door` (and
optionally `.github/hooks`) into the repository instead.

## Use

Ask: *"Review this PR for rollback safety"*, *"Can we roll back main...my-branch?"*, or *"/one-way-door"*.
Node.js 20+ runs the scripts. Without it, the skill falls back to reading the diff.
