---
name: one-way-door
description: 'Rollback-safety review for pull requests, diffs and releases. Answers "if this goes wrong after deploy, can we roll back?" Use when reviewing a PR, checking deploy or release readiness, asking "is this safe to ship" or "can we roll back", or when a change touches database migrations (Flyway, Liquibase, EF Core), event or message schemas (Kafka, JSON Schema, Avro, Service Bus), serialised DTOs, caches, idempotency keys, partner webhooks or API versions. Classifies each change as one-way or two-way, says when the door closes and what breaks on rollback, gives a safe rollback window, finds other code that reads the same table, column or topic, and proposes an expand, migrate, contract, drop split it can generate as branches.'
license: MIT
---

# One-way door

Review a change for rollback safety. A change is a **one-way door** when it leaves behind state (a migrated table,
new-format events on a topic, rewritten cache entries, a payload already sent to a partner) that the **previous
version of the code can't handle**. Rolling back the code then doesn't restore service.

Passing tests don't answer this question, because tests run new code against new state. This skill checks old code
against new state.

## When to use this skill

- Reviewing a pull request or a diff, before merge or before deploy.
- "Is this safe to release?", "Can we roll this back?", "What happens if we revert?"
- The change touches `db/migration`, `Migrations/`, Liquibase changelogs, event schemas or contracts, Kafka or
  Service Bus producers and consumers, DTOs that get serialised, cache code, idempotency or dedupe logic, webhooks
  to partners, API Management, or other public API definitions.
- Someone asks for an "expand/contract" or "safe split" of a change.

## What you need

- `git` with the base branch available locally (`git fetch origin <base>` if needed).
- Node.js 20 or later for the two scripts. They use only the standard library, need no network, and always exit 0
  with JSON on stdout. If Node isn't available, do steps 3 and 4 by reading the diff against `references/patterns.md`.

The scripts sit in `scripts/` next to this file. In this repo that is `.github/skills/one-way-door/scripts/`. If the
skill came from a plugin, use the `scripts/` folder beside the `SKILL.md` you loaded. `SKILL_DIR` below means that folder.

## Procedure

### 1. Work out the base and head

- For a GitHub PR, base is the PR's target branch and head is the PR branch. Locally, head is usually `HEAD` and
  base is `origin/main` or `main`. Use `git symbolic-ref refs/remotes/origin/HEAD` to find the default branch.
- Always compare from the **merge base**. Use `git diff <base>...<head>` with three dots, so changes that landed on
  the base branch since the branch was cut don't show up as part of this PR.

### 2. Get the diff and bucket the files

```bash
git diff --stat <base>...<head>
git diff <base>...<head>
```

Put every changed file into one bucket:

| Bucket | Typical paths and signals |
|---|---|
| Data | `db/migration/V*.sql`, `**/changelog*.{xml,yaml,sql}`, `**/Migrations/*.cs`, entity or ORM mapping changes |
| Messages | `contracts/`, `*.schema.json`, `*.avsc`, `*.proto`, producer and consumer DTOs, Kafka or Service Bus config, serialiser settings |
| State | cache config, `@Cacheable`, Redis or session code, idempotency, dedupe or outbox code |
| External | IaC for queues, topics and subscriptions, API Management or OpenAPI specs, webhook DTOs and clients |
| Code only | everything else |

A PR with only code-only files is usually TWO-WAY, but still check serialised classes and config defaults.

### 3. Run both scripts

```bash
node SKILL_DIR/scripts/scan-migrations.mjs --base <base> --head <head>
node SKILL_DIR/scripts/schema-compat.mjs  --base <base> --head <head> --dir contracts/events
```

- Use `--dir` for each folder that holds JSON Schemas. Find them with `git ls-files '*.schema.json'`. Pass `--dir`
  more than once if there are several.
- Add `--worktree` to include uncommitted changes, for example when reviewing your own edits before committing.
- Each finding has `file`, `line`, `pattern`, `object`, `severity` and `detail`. Check `errors` too. A non-empty
  `errors` array means a file couldn't be read, so look at that file by hand.
- Run `--help` for all options.

### 4. Read the patterns

Open `references/patterns.md` and read the entry for every `pattern` id the scripts reported. Also read it for
anything in the State or External buckets, which the scripts don't cover, and for any file the scripts couldn't
parse. Each entry says when the door closes, what breaks on rollback, and the safe split.

### 5. Find the blast radius

For every touched table, column, topic, event and event field, search the **whole repo**, not just the diff:

```bash
git grep -n -i -E '<table>|<column>|<topic>|<EventName>' <head> -- . ':!*.md'
```

- Search snake_case and camelCase forms (`amount_minor`, `amountMinor`), quoted SQL, ORM mappings
  (`@Column`, `HasColumnName`), report and BI queries, other services, scripts and config.
- Also search the base branch, because the readers that matter are the ones running **today**.
- Mark every reader the PR doesn't change. These usually break first, with no rollback needed.

### 6. Reason about old code against new state

For each finding, run the deploy and then the rollback in your head. Write down:

1. **Version pairs.** Which combinations will run? A new producer with an old consumer, an old consumer with a
   backlog of new events, a new consumer with old events, old instances mid-way through a rolling deploy.
2. **Door closes.** When does the bad state first exist: migration start-up, the first write, the first publish,
   or the IaC apply?
3. **If rolled back.** What does the previous version do with that state? Read its code: entity mappings,
   `ddl-auto`, deserialiser settings (`FAIL_ON_UNKNOWN_PROPERTIES`, type headers, default types), primitive and
   nullable field types, enum handling. Prefer the real error message.
4. **Data loss.** Is anything destroyed or rewritten in a way you can't reverse?

The scripts flag mechanically, and you decide. A `column-drop` of a column that nothing at base or head reads is
not a door. A `not-null` on a column the previous release already writes is safe. Say why in one line.

### 7. Write the comment

Follow `references/output-format.md` exactly: the verdict line (ONE-WAY or TWO-WAY, with the safe rollback window),
numbered findings (door closes, if rolled back, data loss), blast radius, and the suggested split with the offer to
generate it. Include the footer with the script finding counts and the range you checked.

Post or return it the way the user asked. In a PR review, that is the review comment. In chat, show the Markdown.

### 8. Generate the split, but only when asked

When the user says "generate the split" or similar:

1. Create `split/1-expand` from the base branch. Then branch each later step from the one before it
   (`split/2-migrate`, `split/3-contract`, `split/4-drop`).
2. Follow the split table you proposed and the step rules in `references/patterns.md`, under "The general split".
3. For each branch, run the project's tests. Then run both scripts against the previous branch and check that the
   step is TWO-WAY against its predecessor. The last step's drop is expected. Justify it in the commit message.
4. Commit each step with a message that says why it rolls back safely to the step before.
5. Don't push or open PRs unless the user asks. If they do, open them as a stack, each one targeting the previous branch.

If the repo has a rollback test harness (for example `demo/scripts/rollback-test.sh`), run it for each step and
include the results.

## Gotchas

- **Tests passing proves nothing about rollback.** Unit and integration tests run new code against new state.
- **A down or undo migration is not a rollback plan.** It doesn't run when you redeploy old code, and it can't bring
  back values an in-place conversion destroyed.
- **Events outlive deploys.** Rolling back a producer doesn't delete what it published. The topic keeps new-format
  events for the whole retention period, and consumers read them on restart.
- **Lenient readers fail silently.** "Ignore unknown properties" (the Spring Kafka and Jackson default) plus a
  primitive field means a missing value becomes `0`. You get no error and nothing in the dead-letter topic. That is
  worse than a crash.
- **Two-dot diffs lie.** `git diff main..branch` includes changes made on main since the branch was cut. Use three dots.
- **Editing an applied migration is a door already closed.** The file in git no longer matches what production ran.
- **Units hide in types.** `double amount` in pounds and `long amountMinor` in pence are both numbers. Read the
  names and descriptions, not just the types.
- **The cloud agent has limited network access.** The scripts are offline, so don't try to fetch remote refs from
  inside them. Fetch with git first.

## Troubleshooting

| Problem | Fix |
|---|---|
| Script output has `"errors": ["unknown ref …"]` | Fetch the base branch (`git fetch origin main:main`) or pass `--base origin/main`. |
| No migrations found, but you can see SQL in the diff | The path isn't a standard migration folder. Read the file against `patterns.md` by hand. |
| `schema-compat` finds nothing | Check `--dir`. Contracts may be `.avsc` or `.proto`, which the script doesn't parse. Compare them by hand. |
| Node isn't installed | Skip step 3. Read the diff with `patterns.md`. Say in the footer that the scripts didn't run. |
| Huge PR | Bucket the files first and review Data and Messages in depth. List the rest under Checked. |

## References

- `references/patterns.md`: the catalogue of one-way patterns, with how to spot each one, when the door closes,
  what breaks, and the safe split. It ends with the PR #482 worked example.
- `references/output-format.md`: the exact PR comment format, with ONE-WAY and TWO-WAY examples.
- `scripts/scan-migrations.mjs`: destructive or rollback-hostile DDL in Flyway, Liquibase and EF Core migrations.
- `scripts/schema-compat.mjs`: JSON Schema event contracts compared base against head, in the old-reader direction.
