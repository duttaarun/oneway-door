# Copilot formats: verified reference

Checked against the live docs on 7 October 2026. Every deliverable file follows this page, not memory.
If a later phase needs something that isn't here, check the docs again and update this page first.

Sources:
- Skills (cloud agent): https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-skills
- Skills (Copilot CLI): https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills
- Skills (VS Code): https://code.visualstudio.com/docs/copilot/customization/agent-skills
- Skill guidelines: https://awesome-copilot.github.com/instruction/agent-skills/
- Hooks (Copilot): https://docs.github.com/en/copilot/reference/hooks-reference
- Hooks (VS Code): https://code.visualstudio.com/docs/agent-customization/hooks and https://code.visualstudio.com/docs/agents/reference/hooks-reference
- Path instructions: https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
- Plugins (CLI): https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference and https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating
- Plugins (VS Code): https://code.visualstudio.com/docs/agent-customization/agent-plugins
- Agent Plugins 1.0 spec: https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md

---

## 1. Agent skills

### Where Copilot looks

| Scope | Paths | Who reads it |
|---|---|---|
| Project | `.github/skills/<name>/SKILL.md` (also `.claude/skills/`, `.agents/skills/`) | Cloud agent, Copilot code review, Copilot CLI, VS Code agent mode, Copilot app |
| Personal | `~/.copilot/skills/<name>/` (also `~/.agents/skills/`; VS Code also reads `~/.claude/skills/`) | CLI, VS Code |
| Plugin | `skills/<name>/SKILL.md` inside an installed plugin | CLI, VS Code, Copilot app |

We use `.github/skills/one-way-door/`. It is the one path every surface reads.

### SKILL.md frontmatter

| Field | Required | Rules |
|---|---|---|
| `name` | yes | Lowercase letters, digits and hyphens. At most 64 characters. VS Code says it **must match the parent folder name**, and a bad name makes the skill **fail to load silently**. |
| `description` | yes | What the skill does **and when to use it**. VS Code caps it at 1024 characters; the guidelines say 10 to 1024. This is the only text read when deciding whether to load the skill. |
| `license` | no | Free text or an SPDX id. |
| `allowed-tools` | no | Pre-approves tools such as `shell` or `bash`. The docs warn this removes the confirmation step. **We do not set it.** |
| `argument-hint`, `user-invocable`, `disable-model-invocation`, `context: fork` | no | VS Code only. Other surfaces ignore them. We leave them out. |

### Body and bundled files

- Loading happens in three steps. Discovery reads only `name` and `description`. A match loads the SKILL.md body. Other files load only when the body tells the agent to read or run them.
- Keep the body under 500 lines. From about 200 lines, move detail into `references/`.
- All files in the skill folder are available to the agent. The body refers to them by **relative path**, for example `references/patterns.md` or `scripts/scan-migrations.mjs`.
- Conventional folders: `scripts/` (executables, which should support `--help` and fail with clear messages), `references/` (docs read on demand), `assets/`, `templates/`.
- The guidelines recommend a `## Gotchas` section and relative paths throughout.
- Invoking by name: in the CLI and VS Code, `/one-way-door` in the prompt forces the skill.
- Copilot code review suggests a review-focused folder name such as `code-review`. That only matters if we target code review specifically. We don't.

### Checking a skill loaded

- **Copilot CLI:** `/skills list`, `/skills info`, `/skills reload`. From the shell: `copilot skill list`.
- **VS Code:** type `/` in chat and look for the skill, or run **Chat: Open Customizations** (the Configure Skills menu).
- **Cloud agent:** no listing. Look in the session log for the skill being read.

---

## 2. Path-specific custom instructions

- Location: `.github/instructions/<NAME>.instructions.md`. Subfolders are allowed.
- Frontmatter: `applyTo` (required). It takes one glob, or several globs separated by commas inside one quoted string, for example `applyTo: "db/migration/**,contracts/events/**"`.
- `excludeAgent` (optional) is `"code-review"` or `"cloud-agent"`. Leave it out to apply to both.
- When a file Copilot is working on matches, these instructions are **added to** `.github/copilot-instructions.md`, not used instead of it.
- **Unclear:** the GitHub page says that on GitHub.com path instructions are only used by the cloud agent and code review. It doesn't say how the CLI uses them. VS Code applies `*.instructions.md` files by `applyTo` in agent mode. Test both in Phase 7.

---

## 3. Hooks

### Where Copilot looks

| Surface | Hook files read |
|---|---|
| Cloud agent | **Only** `.github/hooks/*.json` in the cloned repo |
| Copilot CLI | Policy dirs, `.github/hooks/*.json`, `~/.copilot/hooks/`, a `hooks` key in `.github/copilot/settings(.local).json` or `~/.copilot/settings.json`, and plugins |
| VS Code | `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, plugins, `.agent.md` frontmatter. Claude-format files are read only if `chat.useClaudeHooks` is on (off by default). |

**Rule for this repo:** deliverable hooks go in `.github/hooks/*.json`, never in `.claude/settings.json`.

### File schema (Copilot format)

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "bash .github/hooks/scripts/check.sh",
        "powershell": "& ./.github/hooks/scripts/check.ps1",
        "cwd": ".",
        "timeoutSec": 15
      }
    ]
  }
}
```

- Command fields: `type` (defaults to `command`), `bash`, `powershell`, `command` (cross-platform fallback), `cwd` (relative to the repo root or absolute), `env`, `timeoutSec` (default 30; `timeout` is an alias), `matcher` (regex tested against the whole tool name). `exec`/`args` exist but are CLI only.
- Other hook types: `http` and `prompt`. We don't use them.
- `disableAllHooks: true` at the top level turns hooks off. Policy hooks ignore it.

### Events

camelCase: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `preCompact`, `agentStop`, `subagentStart`, `subagentStop`, `errorOccurred`, `notification`. CLI only: `permissionRequest`.

PascalCase (VS Code compatible): `PreToolUse`, `PostToolUse`, `Stop` and so on. The event's casing decides the **payload shape** (see below).

### preToolUse stdin

camelCase event (`preToolUse`):

```json
{ "sessionId": "…", "timestamp": 1760000000000, "cwd": "/repo", "toolName": "edit", "toolArgs": { "…": "…" } }
```

- `timestamp` is Unix milliseconds. `toolArgs` arrives **already parsed** as an object, not a JSON string.

PascalCase event (`PreToolUse`), which is also what VS Code sends:

```json
{ "hook_event_name": "PreToolUse", "session_id": "…", "timestamp": "2026-10-07T12:00:00Z", "cwd": "/repo",
  "tool_name": "Edit", "tool_input": { "…": "…" }, "tool_use_id": "…", "transcript_path": "…" }
```

### Tool names

- Copilot CLI and cloud agent: `bash`, `powershell`, `create`, `edit`, `view`, `grep`, `glob`, `web_fetch`, `web_search`, `task`, `ask_user`.
- In PascalCase mode these map to Claude-style names: `create`→`Write`, and `edit`/`str_replace_editor`/`apply_patch`→`Edit`.
- VS Code: the docs **do not list** the built-in tool names. They say to find them through an audit hook or the debug logs.
- **Unclear:** neither doc gives the argument shape of `edit` or `create`. Our hook therefore searches the whole args object for anything that looks like a file path (`path`, `file_path`, `filePath`, `files[]`, patch headers), whatever the tool is called.

### Deny output

The Copilot format: exit 0 and print on stdout:

```json
{ "permissionDecision": "deny", "permissionDecisionReason": "why" }
```

- `permissionDecision` is `allow`, `deny` or `ask`. A reason is required with `deny`. `modifiedArgs` can rewrite the args.
- On the cloud agent, `ask` counts as `deny` because nobody is there to answer.

VS Code's Local harness reads its decision from `hookSpecificOutput`:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "why" } }
```

**Our hook prints both shapes in one JSON object.** Each harness reads the keys it knows. The docs don't say whether VS Code reads the flat Copilot shape, so we don't rely on it.

### Exit codes and timeouts (Copilot)

| Result | preToolUse effect |
|---|---|
| exit 0 | stdout is parsed as the decision |
| exit 2 | deny |
| any other non-zero | **deny** ("hook errored"). preToolUse fails closed. |
| timeout | **fail open**: carries on as if the hook didn't run |

VS Code: exit 0 parses stdout, exit 2 blocks and passes stderr to the model, and any other code is a non-blocking warning.

**Gotcha:** because a crashed preToolUse hook denies *every* tool call on Copilot, our hook script must catch its own errors and exit 0 with `{}` when unsure.

### Surface differences

| | VS Code agent mode | Copilot CLI | Cloud agent |
|---|---|---|---|
| Hook files | `.github/hooks`, user, plugin, Claude format (opt-in) | repo, user, settings, policy, plugin | `.github/hooks/*.json` only |
| Shell | `bash` mapped to its `command` | `bash` or `powershell` | Linux only: `bash` (or `command`). `powershell` is ignored. |
| Payload | Local schema (`tool_name`, `tool_input`) | camelCase or PascalCase, set by the event key | camelCase or PascalCase |
| `ask` | prompts | prompts | becomes `deny` |
| Preview? | Hooks are preview. `chat.useHooks` is on by default. Workspace Trust applies. | GA | GA |
| Environment | local | local, optional sandbox | throwaway Linux box at `/workspace`, network limited to GitHub hosts |

---

## 4. Plugins (how one-way-door becomes "pluggable")

The docs describe two plugin layouts. We ship the **Agent Plugins 1.0** layout, which VS Code, the Copilot CLI and the Copilot app read.

```
plugins/one-way-door/
├── plugin.json                       # $schema + name required, closed schema
├── skills/one-way-door/SKILL.md      # same skill, copied from .github/skills
└── com.github.copilot/
    └── hooks/hooks.json              # Copilot-specific extension folder
```

- `plugin.json` needs `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"` and `name`: 1 to 64 characters, lowercase letters, digits, `-` and `.`, starting and ending alphanumeric, with no `--` or `..`. Optional fields: `version`, `description`, `author{name,email,url}`, `homepage`, `repository`, `license`, `keywords`, `extensions`. **No other top-level keys** are allowed, so no `hooks` or `skills` paths.
- Only direct children of `skills/` that contain a `SKILL.md` count as skills.
- Copilot-specific parts go under `com.github.copilot/`: `agents/`, `commands/`, `rules/`, `hooks/hooks.json`.
- `${PLUGIN_ROOT}` points at the installed plugin folder. VS Code expands it in plugin hook commands. The Agent Plugins spec only guarantees it in `mcp.json`. **Unclear for the Copilot CLI** hook commands, so our plugin hook command checks that the script exists and does nothing if it doesn't. This matters because a failing preToolUse command denies everything.
- Marketplace file: `.github/plugin/marketplace.json` with `name`, `owner{name}`, `metadata`, and `plugins[{name, description, version, source: "./plugins/one-way-door"}]`.
- Installing:
  - CLI: `copilot plugin install OWNER/REPO:plugins/one-way-door`, `copilot plugin install ./plugins/one-way-door`, or `copilot plugin marketplace add OWNER/REPO` then `copilot plugin install one-way-door@<marketplace>`. Reinstall after changes because components are cached.
  - VS Code: set `chat.plugins.enabled: true`, then **Chat: Install Plugin From Source** with the Git URL, or `chat.pluginLocations: { "/abs/path/plugins/one-way-door": true }`. VS Code also finds plugins the CLI installed under `~/.copilot/installed-plugins/`.
- **Cloud agent:** the docs don't say it loads plugins. For the cloud agent, the in-repo `.github/skills` and `.github/hooks` copies are the way in.
- Precedence: project and personal skills override plugin skills with the same name (first found wins).

---

## 5. Cloud agent environment

- `.github/workflows/copilot-setup-steps.yml` with a job named exactly `copilot-setup-steps` runs before the cloud
  agent starts. The job may only use `steps`, `permissions`, `runs-on`, `services`, `snapshot` and `timeout-minutes`.
- The agent's own checkout ignores any `fetch-depth` you set, so fetch the default branch in a later step if you need
  a merge base. The workflow only takes effect once it is on the default branch. If a step fails, the remaining
  steps are skipped.

## 6. Decisions taken from this page

1. `.github/skills/one-way-door/` is the source of truth. `plugins/one-way-door/` is **generated** from it by `tools/build-plugin.mjs`, and a test fails if the two differ.
2. Skill frontmatter carries only `name`, `description` and `license`, which every surface supports.
3. The hook reads both payload shapes and prints both output shapes. It fails open (exit 0 with `{}`) on any internal error.
4. Skill scripts are run as `node <skill dir>/scripts/<name>.mjs`. SKILL.md names the in-repo path and says to resolve it next to SKILL.md when the skill was installed from a plugin.
5. Things to confirm by hand in Phase 7: path instructions in the CLI, VS Code reading the hook's deny output, and the CLI expanding `${PLUGIN_ROOT}` in plugin hooks.
