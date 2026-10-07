# Progress log

Newest phase at the bottom. Each entry: what's done, decisions, gotchas.

## Phase 0: Copilot formats (done)

- Wrote `docs/copilot-formats.md` from the live GitHub and VS Code docs (checked 7 Oct 2026).
- Decision: the in-repo `.github/skills/one-way-door/` is the source of truth. A generated Agent Plugins 1.0
  package under `plugins/one-way-door/` makes it installable in any repo ("pluggable").
- Decision: the preToolUse hook reads both payload shapes (camelCase `toolName/toolArgs` and VS Code's
  `tool_name/tool_input`) and prints both deny shapes (flat and `hookSpecificOutput`).
- Gotcha: on Copilot a preToolUse hook that exits non-zero **denies every tool call**. The hook must catch its own errors.
- Gotcha: the docs don't give the `edit`/`create` argument shapes or VS Code tool names. The hook matches on paths, not tool names.
- To confirm by hand later: path instructions in the CLI, VS Code honouring the deny, `${PLUGIN_ROOT}` in CLI plugin hooks.
