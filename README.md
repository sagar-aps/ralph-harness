# Ralph

![Ralph](ralph.webp)

Ralph is a minimal, file‑based agent loop for autonomous coding. Each iteration starts fresh, reads the same on‑disk state, and commits work for one story at a time.

## How it works

Ralph treats **files and git** as memory, not the model context:

- **PRD (JSON)** defines stories, gates, and status
- **Loop** executes one story per iteration
- **State** persists in `.ralph/`

![Ralph architecture](diagram.svg)

## Global CLI (recommended)

Install and run Ralph from anywhere:

```bash
npm i -g @iannuttall/ralph
ralph prd # launches an interactive prompt
ralph build 1 # one Ralph run
```

### Template hierarchy

Ralph will look for templates in this order:

1. `.agents/ralph/` in the current project (if present)
2. Bundled defaults shipped with this repo

State and logs always go to `.ralph/` in the project.

### Install templates into a project (optional overrides)

```bash
ralph install
```

This creates `.agents/ralph/` in the current repo so you can customize prompts and loop behavior. During install, you’ll be asked if you want to add the required skills.

### Install required skills (optional)

```bash
ralph install --skills
```

You’ll be prompted for agent (codex/claude/droid/opencode) and local vs global install. Skills installed: **commit**, **dev-browser**, **prd**.
If you skipped skills during `ralph install`, you can run `ralph install --skills` anytime.

## Quick start (project)

1) Create your PRD (JSON) or generate one:
```
ralph prd
```
Requires the **prd** skill (install via `ralph install --skills`).

Example prompt text:
```
A lightweight uptime monitor (Hono app), deployed on Cloudflare, with email alerts via AWS SES
```

Default output (agent chooses a short filename in `.agents/tasks/`):
```
.agents/tasks/prd-<short>.json
```

2) Run one build iteration:
```
ralph build 1 # one Ralph run
```

No‑commit dry run:
```
ralph build 1 --no-commit # one Ralph run
```

Override PRD output for `ralph prd`:
```
ralph prd --out .agents/tasks/prd-api.json
```
Optional human overview (generated from JSON):
```
ralph overview
```
This writes a tiny overview alongside the PRD: `prd-<slug>.overview.md`.

PRD story status fields are updated automatically by the loop:
- `open` → selectable
- `in_progress` → locked by a running loop (with `startedAt`)
- `done` → completed (with `completedAt`)

If a loop crashes and a story stays `in_progress`, you can set `STALE_SECONDS` in `.agents/ralph/config.sh` to allow Ralph to automatically reopen stalled stories.

## Override PRD paths

You can point Ralph at a different PRD JSON file via CLI flags:

```bash
ralph build 1 --prd .agents/tasks/prd-api.json # one Ralph run
```

Optional progress override:

```bash
ralph build 1 --progress .ralph/progress-api.md # one Ralph run
```

If multiple PRD JSON files exist in `.agents/tasks/` and you omit `--prd`, Ralph will prompt you to choose.

Optional config file (if you installed templates):

```
.agents/ralph/config.sh
```

## Choose the agent runner

Set `AGENT_CMD` in `.agents/ralph/config.sh` to switch agents:

```
AGENT_CMD="codex exec --yolo -"
AGENT_CMD="claude -p --dangerously-skip-permissions \"\$(cat {prompt})\""
AGENT_CMD="droid exec --skip-permissions-unsafe -f {prompt}"
AGENT_CMD="opencode run \"$(cat {prompt})\""
```

Or override per run:

```
ralph prd --agent=codex
ralph build 1 --agent=codex # one Ralph run
ralph build 1 --agent=claude # one Ralph run
ralph build 1 --agent=droid # one Ralph run
ralph build 1 --agent=opencode # one Ralph run
```

If the CLI isn’t installed, Ralph prints install hints:

```
codex    -> npm i -g @openai/codex
claude   -> curl -fsSL https://claude.ai/install.sh | bash
droid    -> curl -fsSL https://app.factory.ai/cli | sh
opencode -> curl -fsSL https://opencode.ai/install.sh | bash
```

## Review loop (builder/reviewer, against a separate target repo)

The default `ralph build` runs a single agent in the current repo. The **review
loop** is a second mode that orchestrates work on a **separate target repo**
using an adversarial **builder → check → reviewer** cycle. The reviewer's
`VERDICT: FAIL` is fed back to the builder automatically; the loop stops at
`READY_FOR_HUMAN_REVIEW` (on PASS + passing checks) or `FAILED_MAX_ITERATIONS`.
It never merges to the target's main branch.

### Harness repo vs target repo

- **This repo** is the harness/orchestrator. It is not modified during a run.
- The **target repo** is passed via `--repo` (or `TARGET_REPO`). It holds the
  app, the PRD/tasks (`.agents/tasks/*.json`), `AGENTS.md`/`CLAUDE.md`, and a
  check command (default `./scripts/check.sh`).
- All builder/reviewer/check commands run with their working directory set to a
  **git worktree of the target repo** — never the harness repo.

### Roles vs backends

A **role** is a job in the workflow (`builder`, `reviewer`, …). A **backend** is a
concrete agent CLI command (`claude`, `opencode-z`, `codex`, …). They are fully
decoupled: any backend can be assigned to any role.

- Backends are defined in `.agents/ralph/agents.sh` as `AGENT_<NAME>_CMD`. Built
  in: `claude`, `codex`, `droid`, `opencode`, `opencode-z`, `codex-write`,
  `codex-readonly`. Add a new one with no code change by defining
  `AGENT_<NAME>_CMD` (dashes → underscores, e.g. `my-agent` → `AGENT_MY_AGENT_CMD`).
- Assign roles → backends per run with `--builder`/`--reviewer`, via
  `BUILDER`/`REVIEWER` env vars, or in `.agents/ralph/review-config.sh`.
- The reviewer is read-only **by prompt**; pick a sandboxed backend
  (`--reviewer codex-readonly`) to also enforce it at the tool level.

### Run one PRD/task

```bash
ralph review 1 --repo /path/to/target --builder opencode-z --reviewer claude
```

Equivalent forms:

```bash
# explicit task id instead of 1-based index
ralph review --repo /path/to/target --task US-001 --builder opencode-z --reviewer claude

# triggered through `build` by passing --repo/--reviewer
ralph build 1 --repo /path/to/target --builder opencode-z --reviewer claude

# env-driven
TARGET_REPO=/path/to/target BUILDER=opencode-z REVIEWER=claude ralph review 1
```

Useful flags: `--max-iterations <n>` (default 5), `--check '<cmd>'`
(default `./scripts/check.sh`), `--branch <name>`, `--allow-dirty`,
`--no-worktree`, `--verdict-regex`.

### How the loop works

```
for iteration in 1..MAX:
  render builder prompt (incl. previous reviewer feedback + check logs)
  run builder backend         (cwd = target worktree)
  run check command           (cwd = target worktree)
  capture git diff vs base
  render reviewer prompt (diff + check output + builder handoff)
  run reviewer backend        (read-only)
  parse VERDICT: PASS|FAIL
  if checks passed AND verdict PASS -> READY_FOR_HUMAN_REVIEW
  else feed reviewer output + check log back into the next builder iteration
```

The builder must write `.agent-handoff.md` every attempt (summary, files touched,
commands run, repo facts, failed approaches, incomplete items, suggested next fix).
Saying "done" does not complete the task — only a passing reviewer + passing
checks do.

### Where logs are stored

Artifacts persist in the **target repo** under `.ralph/runs/<run-id>/`:

```
.ralph/runs/<run-id>/
  task.md                 config.resolved.env
  builder_prompt_N.md     builder_output_N.log
  check_N.log             diff_N.patch        handoff_N.md
  reviewer_prompt_N.md    reviewer_output_N.md
  final_status.md
```

Add `.ralph/` to the target repo's `.gitignore` (the loop already ignores it in
its dirty check).

### Inspect the result / READY_FOR_HUMAN_REVIEW

`READY_FOR_HUMAN_REVIEW` means checks passed and the reviewer voted PASS. The work
sits on an unmerged `ralph/<task>-<run-id>` branch in a worktree. Nothing is
merged automatically. To inspect:

```bash
cd <worktree path printed at the end>
git diff <base-ref>          # shown in final_status.md
git log --oneline <base-ref>..HEAD
# when finished:
git -C /path/to/target worktree remove <worktree path>
```

### Known limitations / assumptions

- Target must be a clean git repo (use `--allow-dirty` to override).
- PRD format reuses the existing `.agents/tasks/*.json` story schema. Story status
  is **not** mutated (human-in-the-loop); selection picks the first actionable open
  story unless `--task`/`<index>` is given.
- Worktrees are created at `<target-parent>/.ralph-worktrees/` (override with
  `RALPH_WORKTREE_DIR`) and are **not** auto-removed.
- A `PASS` requires both a passing check command **and** a `VERDICT: PASS`; a
  missing/garbled verdict line is treated as `FAIL`.

## State files (.ralph/)

- `progress.md` — append‑only progress log
- `guardrails.md` — “Signs” (lessons learned)
- `activity.log` — activity + timing log
- `errors.log` — repeated failures and notes
- `runs/` — raw run logs + summaries

## Notes

- `.agents/ralph` is portable and can be copied between repos.
- `.ralph` is per‑project state.
- Use `{prompt}` in `AGENT_CMD` when agent needs a file path instead of stdin.
- Examples: see `examples/commands.md`.
- **OpenCode server mode**: For faster performance with OpenCode, run `opencode serve` in a separate terminal and uncomment the `AGENT_OPENCODE_CMD` lines in `.agents/ralph/agents.sh` to use `--attach http://localhost:4096`. This avoids cold boot on every run.

## Tests

Dry-run smoke tests (no agent required):

```bash
npm test
```

Fast agent health check (real agent call, minimal output):

```bash
npm run test:ping
```

Optional integration test (requires agents installed):

```bash
RALPH_INTEGRATION=1 npm test
```

Full real-agent loop test:

```bash
npm run test:real
```
