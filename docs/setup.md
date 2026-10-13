# Setting up One-Way Door

One-Way Door is a GitHub Copilot agent skill. Ask Copilot *"if this goes wrong after deploy, can we roll back?"* and it
reviews the change for one-way doors. This guide covers what you need, and how to set it up for each place Copilot
runs:

- [VS Code (agent mode)](#4-vs-code)
- [Copilot CLI](#5-copilot-cli)
- [Copilot cloud agent](#6-copilot-cloud-agent)
- [Copilot code review on GitHub](#7-copilot-code-review)

Checked against the live GitHub and VS Code docs on **13 October 2026** ([sources](#sources)). Copilot changes often.
Anything marked **(check)** isn't settled by the docs: confirm it on your own setup.

---

## 1. What you're installing

| Part | Path | Needed? | What it does |
|---|---|---|---|
| **The skill** | `.github/skills/one-way-door/` (`SKILL.md`, `references/`, `scripts/`) | **Yes** | Reviews a diff. Says one-way or two-way, when the door closes, what breaks on rollback, the blast radius, and a safe split. |
| **The path rule** | `.github/instructions/migrations.instructions.md` | Optional | Tells Copilot the rollback rules whenever it touches migrations or event contracts. |
| **The hook** | `.github/hooks/one-way-door.json` and `.github/hooks/scripts/` | Optional | Stops the agent editing a migration that is already on the default branch. |
| **Agent environment** | `.github/workflows/copilot-setup-steps.yml` | For the cloud agent and code review | Installs Node 20 and fetches the default branch, so the scripts can run and diff from the merge base. |
| **The plugin** | `plugins/one-way-door/` | Instead of copying | The skill and the hook as one install, for VS Code and Copilot CLI. |

Copilot finds the skill on its own. There is nothing to register. It reads only the skill's `name` and
`description`, and loads the rest when a request matches. The `name` must equal the folder name, `one-way-door`.

---

## 2. Tech stack

### 2.1 On the machine that runs the skill

This is your laptop for VS Code and Copilot CLI. For the cloud agent and code review, it's GitHub's runner.

| What | Version | Why | If it's missing |
|---|---|---|---|
| **git** | Any 2.x | The skill diffs `base...head` from the merge base and searches the repo for other readers. | **Required.** The skill can't work without it. |
| **The base branch, with history** | Not a shallow clone | A three-dot diff needs the merge base. | The scripts report `unknown ref`. Run `git fetch origin main:main`, and `git fetch --unshallow` on a shallow clone. |
| **Node.js** | **20 or later** | Runs the two scripts (`scan-migrations.mjs`, `schema-compat.mjs`). They use only the standard library: no `npm install`, no network. | The skill still works, using the pattern catalogue alone. Its PR comment says the scripts didn't run. |

### 2.2 For the hook (optional)

| What | Where | Why |
|---|---|---|
| **bash 3.2+**, `grep`, `sed` | macOS, Linux, the cloud agent | Runs `deny-applied-migration-edit.sh`. macOS's built-in bash 3.2 is enough. |
| **PowerShell 7+ (`pwsh`)** | Windows | Runs the `.ps1` twin. Tested on pwsh 7.5. Not tested on Windows PowerShell 5.1. |

**Windows warning.** For Copilot CLI, a preToolUse hook that crashes **denies every tool call**. If the hook's shell is
missing, expect Copilot to be blocked from doing anything **(check)**. Copilot CLI on Windows already requires
PowerShell 6 or later, so `pwsh` is normally there. The same applies if your organisation only allows **signed**
PowerShell scripts (an `AllSigned` execution policy set by Group Policy): the hook's `.ps1` won't run. Check with
`Get-ExecutionPolicy -List`. If in doubt, leave the hook out: the skill doesn't need it.

### 2.3 Copilot itself

| What | Needed for | Notes |
|---|---|---|
| **A GitHub Copilot plan** | Everything | **Free:** VS Code agent mode and Copilot CLI only. No cloud agent, and code review only as "Review selection" in VS Code. **Student, Pro, Pro+, Max, Business, Enterprise:** all four surfaces. |
| **VS Code 1.109 or later** | VS Code | Agent skills became generally available in 1.109 and are on by default. The current release is 1.141. |
| **Copilot CLI** | Copilot CLI | Install with npm (needs **Node 22+**), WinGet or Homebrew. See [section 5](#5-copilot-cli). |
| **A repository on GitHub.com, with Actions** | Cloud agent, code review | The cloud agent and code review run on GitHub Actions runners. Code review without runners falls back to a limited mode. |
| **Org policies** (Business, Enterprise) | Depends on the surface | An admin enables them. See each section. |

**Cost (Business, Enterprise).** Copilot is billed in AI credits (1 credit = $0.01). Business includes 1,900 per user
and Enterprise 3,900, pooled across the org. Chat, the CLI and the cloud agent use them. Code review uses credits
**and** Actions minutes: roughly $0.05–$1 per review on the Lite setting and $0.25–$5 on Balanced.

### 2.4 What it reads in your repository

| Your stack | Covered by |
|---|---|
| **Flyway** SQL migrations (`V<n>__<name>.sql`), **Liquibase** (XML, YAML, formatted SQL), **EF Core** migrations | `scan-migrations.mjs`, plus judgement |
| **JSON Schema** event contracts (`*.schema.json`), by default in `contracts/events/` | `schema-compat.mjs` (other folders via `--dir`; the skill finds them with `git ls-files '*.schema.json'`) |
| **Avro, Protobuf**, serialised DTOs, caches, idempotency keys, partner webhooks, API versions | The 24-pattern catalogue (`references/patterns.md`) and Copilot's judgement. No scripts. |
| Code in **any language** that reads the same table, column or topic | `git grep`, from the skill's blast-radius step |

**It doesn't need:** a server, a database, Docker, npm packages, an MCP server, network access or any account
beyond Copilot. The skill never builds or runs your code.

(The demo system in `demo/` needs Java 21. That's only for the demo; see [demo/control-centre/README.md](../demo/control-centre/README.md).)

---

## 3. Choose how to install

| | VS Code | Copilot CLI | Cloud agent | Code review |
|---|---|---|---|---|
| **Copy into the repo** (option A) | ✓ | ✓ | ✓ | ✓ |
| **Install the plugin** (option B) | ✓ | ✓ | ✗ (doesn't load plugins) | ✗ |
| Path rule works | ✓ | ✓ | ✓ | ✓ |
| Hook works | ✓ (preview) | ✓ | ✓ (`bash` only) | not documented |

Use **option A** for a team repository: everyone, and every surface, gets it from git. Use **option B** to try it on
your own machine across many repos.

### Option A: copy into the repository

macOS, Linux or Git Bash:

```bash
SRC=/path/to/one-way-door                     # a checkout of this repo
mkdir -p .github/skills .github/instructions .github/hooks .github/workflows
cp -R "$SRC/.github/skills/one-way-door" .github/skills/                            # the skill
cp "$SRC/.github/instructions/migrations.instructions.md" .github/instructions/     # optional: the rule
cp -R "$SRC/.github/hooks/." .github/hooks/                                         # optional: the hook
cp "$SRC/.github/workflows/copilot-setup-steps.yml" .github/workflows/              # cloud agent and code review
```

Windows PowerShell:

```powershell
$SRC = 'C:\path\to\one-way-door'
New-Item -ItemType Directory -Force .github\skills, .github\instructions, .github\hooks, .github\workflows | Out-Null
Copy-Item -Recurse "$SRC\.github\skills\one-way-door" .github\skills\
Copy-Item "$SRC\.github\instructions\migrations.instructions.md" .github\instructions\
Copy-Item -Recurse "$SRC\.github\hooks\*" .github\hooks\
Copy-Item "$SRC\.github\workflows\copilot-setup-steps.yml" .github\workflows\
```

Then:

1. **Point the rule at your paths.** Edit `applyTo` in `migrations.instructions.md`. The default covers
   `**/db/migration/**`, `**/db/changelog/**`, `**/migrations/**`, `**/Migrations/**`, `**/liquibase/**` and
   `contracts/events/**`.
2. **Already have a `copilot-setup-steps.yml`?** Add its two steps to yours instead of replacing it: `actions/setup-node`
   with `node-version: 20`, and the step that fetches the default branch. The job must stay named
   `copilot-setup-steps`.
3. **Commit and merge to the default branch.** The cloud agent reads `copilot-setup-steps.yml` only from the default
   branch. Code review reads skills and instructions from the PR's head branch, so the files must be on the branch
   being reviewed too.

### Option B: install the plugin

Copilot CLI:

```bash
copilot plugin install OWNER/REPO:plugins/one-way-door        # once this repo is on GitHub
copilot plugin install /absolute/path/to/one-way-door/plugins/one-way-door   # from a local checkout
```

Or through this repo's marketplace: `copilot plugin marketplace add OWNER/REPO`, then
`copilot plugin install one-way-door@one-way-door`.

VS Code: set `"chat.plugins.enabled": true`, then run **Chat: Install Plugin From Source** with the repository URL.
For a local checkout, add it to settings instead:

```json
"chat.pluginLocations": { "/absolute/path/to/one-way-door/plugins/one-way-door": true }
```

Notes:

- **A repo copy wins.** A repo or personal skill with the same name overrides the plugin's copy.
- **Reinstall after updates.** Plugins are cached.
- **The plugin hook may not run in Copilot CLI.** It uses `${PLUGIN_ROOT}`, and the docs don't say the CLI expands
  it there **(check)**. If it doesn't, the hook quietly allows everything, by design. The in-repo hook from option A
  doesn't have this problem.

---

## 4. VS Code

### Before you start

- **VS Code 1.109 or later**, signed in to Copilot. Click the Copilot icon in the Status Bar and choose **Use AI
  Features**.
- **Git and Node 20+** on the PATH that VS Code's terminal sees. Run `node -v` in VS Code's terminal to check.
- **Business or Enterprise:** your admin enables the **"Copilot Agent Mode in IDE Chat"** policy. Hooks are a preview
  feature in VS Code. If your org turns off **"Editor preview features"**, expect hooks not to run **(check)**.
- **Managed laptops:** device policies can switch customisations off. `ChatHooks` and `ChatAllowManagedHooksOnly` can
  turn off repo hooks. `ChatStrictPluginOnlyCustomization` can turn off repo skills and instructions.
  `ChatPluginsEnabled` can turn off plugins. Ask IT if the skill doesn't appear.

### Steps

1. **Open the repository folder**, the one that contains `.github/`, as the workspace root.
2. **Trust the workspace** when asked. Restricted Mode disables agents, and workspace hooks need trust.
3. **Open Chat and choose Agent.** Skills don't run in Ask mode.
4. **Check these settings** (all can be found under Settings, by searching for the name):

   | Setting | Should be | Why |
   |---|---|---|
   | `chat.useHooks` | `true` (the default) | Runs `.github/hooks`. |
   | `github.copilot.chat.codeGeneration.useInstructionFiles` | `true` **(check)** | Applies `.github/instructions` in the Local agent. The docs don't state the default. |
   | `chat.includeApplyingInstructions` | `true` | Includes instructions whose `applyTo` matches. |

5. **Optional: stop the approval prompts for the skill's scripts.** Common read-only `git` commands are approved
   automatically. To also allow the two scripts without asking:

   ```json
   "chat.tools.terminal.autoApprove": {
     "/^node \\S*one-way-door[\\\\/]scripts[\\\\/](scan-migrations|schema-compat)\\.mjs\\b/": true
   }
   ```

   Otherwise, approve them once when asked. For a live demo, approve them in a rehearsal first.

### Check it loaded

- **Skill:** type `/` in Chat and look for `one-way-door`. Or type `/skills`, or run **Chat: Open Customizations**.
- **Hook:** type `/hooks`.
- **Why something didn't load:** run **Developer: Open Agent Debug Logs**. Its "Discovery" events say whether each
  skill, hook or instruction was loaded, skipped or rejected.
- **What the hook did:** View → Output → **GitHub Copilot Chat Hooks**, for the Local agent.

### First run

```text
Review the my-branch branch against main. If this goes wrong after deploy, can we roll back?
```

- Approve the `git` and `node` commands it asks to run.
- The answer should start with `**Verdict: ONE-WAY**` or `**Verdict: TWO-WAY**`.
- **References** under the answer should list `SKILL.md`.
- To force the skill, type `/one-way-door main...my-branch`.

### Windows

VS Code now has several session targets:
- **Copilot target:** hooks behave as in Copilot CLI. The `powershell` command runs, so PowerShell 7 must be on PATH.
- **Local target:** the docs don't say how a Copilot-format hook's fields are mapped **(check)**. A Local hook that
  fails only produces a warning; it doesn't block anything.

Test the hook once on the laptop you'll use. Ask: *"In V1__…sql change a column to varchar(128). I know it's applied;
edit it anyway."* Copilot should be refused with a `one-way-door:` reason. If the path rule makes Copilot refuse first,
push once more.

---

## 5. Copilot CLI

### Install

| OS | Command |
|---|---|
| Any, with Node **22+** | `npm install -g @github/copilot` |
| Windows | `winget install GitHub.Copilot` |
| macOS | `brew install --cask copilot-cli` |

- **Operating systems:** Linux, macOS, and Windows in PowerShell 6+ or WSL.
- **Business or Enterprise:** your admin enables the **"Copilot CLI"** policy.
- **The skill's scripts** need Node 20+. If you installed the CLI with npm, you already have Node 22.

### Sign in

```bash
copilot          # then type /login
```

Or run `copilot login`. To use a token instead, it must be a **fine-grained** personal access token with the
**"Copilot Requests"** permission. Classic tokens don't work.

### Run

1. `cd` to the repository root and run `copilot`.
2. Trust the folder when asked, for this session or permanently.
3. Type `/skills list`. `one-way-door` should be there (`/skills info one-way-door` shows its details).
4. Ask:

   ```text
   Review the my-branch branch against main. If this goes wrong after deploy, can we roll back?
   ```

5. The CLI shows each command before running it. Approve the `git` and `node …mjs` commands.

The CLI reads `.github/skills`, `.github/hooks/*.json`, `.github/copilot-instructions.md` and `.github/instructions/`.
Path instructions apply when `applyTo` matches a file it is working on.

**Hook check:** ask it to edit an applied migration. The CLI shows the denied tool call inline, with the
`one-way-door:` reason.

---

## 6. Copilot cloud agent

The cloud agent works on GitHub, in its own Actions environment, and opens or updates pull requests.

### Before you start

- **A plan other than Free.**
- **Business or Enterprise:** the cloud agent is **off by default**.
  - **Org:** Settings → Code, planning, and automation → Copilot → Policies → **"Copilot cloud agent"** → Enabled.
    Then Copilot → Cloud agent → **Repository access**: include your repository.
  - **Enterprise:** AI controls → Agents → Copilot Cloud Agent.
- **Option A files on the default branch**, including `.github/workflows/copilot-setup-steps.yml`.

### What it uses

| Part | Used? | Notes |
|---|---|---|
| Skill (`.github/skills`) | ✓ | |
| Path rule (`.github/instructions`) | ✓ | |
| Hook (`.github/hooks/*.json`) | ✓ | Only the `bash` command runs; `powershell` is ignored. Our bash script needs nothing extra. |
| Plugin | ✗ | Not loaded. Use option A. |
| `copilot-setup-steps.yml` | ✓ | The job must be named `copilot-setup-steps`, on the default branch, using only `steps`, `permissions`, `runs-on`, `services`, `snapshot` and `timeout-minutes` (59 at most). Ours uses `ubuntu-latest`. |

**Firewall:** on by default. It only limits what the agent's own commands reach. Our scripts are offline, so it
doesn't affect them. The setup steps install Node 20 because the docs don't say which Node the runner has.

### Run it

Any of these works:
- **On a pull request,** comment: `@copilot Review this PR for rollback safety and post the one-way door check.`
- **On an issue,** assign it to Copilot.
- **From the agents panel** at github.com/copilot/agents.

### Check it worked

There's no skill list here. Open the session log, and look for `SKILL.md` being read and the two `node …mjs` commands.

---

## 7. Copilot code review

Copilot code review comments on a pull request, like a human reviewer.

### Before you start

- **Plan:** any paid plan. On Free, code review is only "Review selection" in VS Code.
- **Business or Enterprise:** your admin enables the **"Copilot code review"** policy. For reviewers without a Copilot
  licence, they enable **"AI credits paid usage"**, then **"Allow members without a Copilot license to use Copilot
  code review in GitHub.com"**.
- **GitHub Actions runners.** Without them, code review falls back to a limited mode.
- **Option A files on the PR's head branch.** Code review reads skills and instructions from there.

### Turn it on

- **One PR:** Reviewers → **Copilot** → Request.
- **Every PR:** add a repository, org or enterprise **ruleset** with **"Automatically request Copilot code review"**.
  Optionally also turn on **"Review new pushes"** and **"Review draft pull requests"**.

### What to expect

- **The skill is used "when relevant".** Code review decides from the skill's description. Ours names PR review,
  migrations and schema changes, but code review may not pick it for every PR **(check)**.
- **It runs in an Actions environment** set up by `copilot-setup-steps.yml`, or by `copilot-code-review.yml` if you
  add one.
- **Undocumented:** whether code review runs a skill's scripts, and whether it fires `.github/hooks` **(check)**. If the
  scripts don't run, the skill falls back to the pattern catalogue and says so in its comment.
- **The full scripted review on a PR:** ask the cloud agent (section 6) with an `@copilot` comment instead.

---

## 8. Check it end to end

Run the scripts on their own first. If they work, the skill has what it needs:

```bash
node .github/skills/one-way-door/scripts/scan-migrations.mjs --base main --head my-branch
node .github/skills/one-way-door/scripts/schema-compat.mjs  --base main --head my-branch
```

Both print JSON and always exit 0. Findings are data, not errors.

In this repository, the demo branch gives known answers. Run `--base main --head pr-482-minor-units`: the first
script finds 3 problems and the second finds 5. [docs/copilot-test-checklist.md](copilot-test-checklist.md) has five
fixed prompts and what a good answer looks like on each surface.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| The skill isn't in `/`, `/skills` or `/skills list` | `name:` in `SKILL.md` doesn't match the folder name. VS Code drops it **silently**. | Keep the folder called `one-way-door`. |
| | You opened a subfolder, not the repo root | Open the folder that contains `.github/`. |
| | Untrusted workspace, or an org or device policy | Trust the workspace; ask your admin (sections 4–7). |
| Copilot answers but doesn't use the skill | The prompt didn't match the description | Say "roll back", "rollback safety" or "safe to release", or type `/one-way-door main...my-branch`. |
| Script output has `"errors": ["unknown ref …"]` | The base branch isn't available locally | `git fetch origin main:main`, or pass `--base origin/main`. |
| No merge base | Shallow clone | `git fetch --unshallow`. On the cloud agent, check `copilot-setup-steps.yml` is on the default branch. |
| The comment says the scripts didn't run | Node isn't installed or isn't on PATH | Install Node 20+. The review still works, from the catalogue. |
| **Every** tool call is denied (Copilot CLI, Windows) | The hook's shell is missing, or policy blocks unsigned scripts, and a crashing preToolUse hook denies everything | Install PowerShell 7 and check `Get-ExecutionPolicy -List`, or remove `.github/hooks/one-way-door.json`. |
| The hook never fires | `chat.useHooks` off, untrusted workspace, a device policy, or the plugin's `${PLUGIN_ROOT}` not expanded | Use the in-repo hook (option A). Check the "GitHub Copilot Chat Hooks" output in VS Code. |
| The cloud agent ignores the setup steps | The file isn't on the default branch, or the job is named differently | Merge it to the default branch; keep the job named `copilot-setup-steps`. |

---

## 10. Updating and removing

- **Option A:** copy the folders again and commit. To remove, delete `.github/skills/one-way-door`, the rule, the hook
  files and the two setup steps.
- **Option B:** in Copilot CLI, `copilot plugin uninstall one-way-door`, then install again to update. In VS Code,
  remove the entry from `chat.pluginLocations` or uninstall it from the Customizations view.

---

## Sources

Checked on 13 October 2026.

- Copilot plans: https://docs.github.com/en/copilot/get-started/plans
- Billing: https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing
- Agent skills: https://docs.github.com/en/copilot/concepts/agents/about-agent-skills
- Org policies: https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-policies and
  https://docs.github.com/en/copilot/reference/enterprise-administrators/policy-conflicts
- Enterprise-managed settings (plugins): https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings
- Hooks reference (CLI and cloud agent): https://docs.github.com/en/copilot/reference/hooks-reference
- VS Code 1.109 release notes (skills GA): https://code.visualstudio.com/updates/v1_109
- VS Code hooks: https://code.visualstudio.com/docs/agent-customization/hooks
- VS Code custom instructions: https://code.visualstudio.com/docs/agent-customization/custom-instructions
- VS Code agent plugins: https://code.visualstudio.com/docs/agent-customization/agent-plugins
- VS Code approvals: https://code.visualstudio.com/docs/agents/run/approvals
- VS Code agent debug view: https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view
- VS Code enterprise AI settings: https://code.visualstudio.com/docs/enterprise/manage-ai-settings
- Workspace Trust: https://code.visualstudio.com/docs/editing/workspaces/workspace-trust
- Install Copilot CLI: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli
- Copilot CLI sign-in: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- Copilot CLI instructions: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions
- Copilot CLI plugins: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference
- Cloud agent, enabling: https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/add-copilot-cloud-agent
- Cloud agent, environment: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment
- Cloud agent, skills: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
- Cloud agent, firewall: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall
- Code review, using: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review
- Code review, configuring: https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review
- Code review, concepts and cost: https://docs.github.com/en/copilot/concepts/agents/code-review
