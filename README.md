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

### Local install from this checkout (recommended for the harness)

If you are running this harness from a local clone, link it once so the `ralph`
command points at your checkout (picks up your edits immediately, no publish):

```bash
cd /path/to/ralph-harness   # the directory where you cloned this repo
npm link
```

After that, use `ralph ...` directly from anywhere:

```bash
ralph review 1 --repo /path/to/target --builder opencode-z --reviewer claude
```

### Or install the published package

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
  render builder prompt (incl. previous reviewer feedback + check/preview/e2e logs)
  run builder backend                 (cwd = target worktree)
  run check command                   (cwd = target worktree)
  capture git diff vs base
  if preview enabled:
    preview-up -> preview-url -> e2e   (cwd = target worktree)
  render reviewer prompt (diff + check/preview/e2e output + builder handoff)
  run reviewer backend                (read-only)
  parse VERDICT: PASS|FAIL
  if check==0 AND (preview disabled OR preview-up+e2e ok) AND verdict PASS:
    -> READY_FOR_HUMAN_REVIEW
  else feed reviewer output + check/preview/e2e logs back into the next builder
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
- A `PASS` requires a passing check command, passing preview/e2e (if enabled),
  **and** a `VERDICT: PASS`; a missing/garbled verdict line is treated as `FAIL`.

### Scaffold a target repo (`ralph init-target`)

```bash
ralph init-target --repo /path/to/target                  # generic
ralph init-target --repo /path/to/target --type nextjs-postgres
```

Creates `.agents/tasks/`, a `ralph.target.json` config, `scripts/check.sh`, adds
`.ralph/` + `.agent-handoff.md` to `.gitignore`, and (for `nextjs-postgres`) adds
executable `scripts/preview-up.sh`, `preview-down.sh`, `preview-url.sh`, `e2e.sh`
templates. Existing files are not overwritten unless you pass `--force`.

### Target config (`ralph.target.json`)

Committed to the **target** repo. CLI flags override it; it overrides the
built-in defaults.

```json
{
  "check": "./scripts/check.sh",
  "preview": {
    "enabled": true,
    "up": "./scripts/preview-up.sh",
    "down": "./scripts/preview-down.sh",
    "url": "./scripts/preview-url.sh",
    "e2e": "./scripts/e2e.sh",
    "host": "localhost",
    "keepOnPass": true,
    "keepOnFail": false
  }
}
```

### Website preview + e2e lifecycle

When preview is enabled (config `preview.enabled` or `--preview`), each iteration
adds `preview-up → preview-url → e2e` between the check and the reviewer. If
`preview-up` or `e2e` fails, the iteration fails and its logs are fed back to the
builder (a regression caught by e2e is treated as a failure of the current task,
not a new one). After the run, the preview is torn down unless `keepOnPass`/
`keepOnFail` (or `--keep-preview-on-fail`) says to leave it running.

The target's preview scripts receive a **dynamic run environment** (they read env,
they do not parse CLI args):

| Env var | Meaning |
| --- | --- |
| `RALPH_RUN_ID` | unique id for this run |
| `RALPH_TARGET_REPO` | the target repo path |
| `RALPH_WORKTREE` | the worktree the scripts run in (cwd) |
| `RALPH_BRANCH` | the run branch |
| `RALPH_BASE_COMMIT` | commit the branch started from |
| `RALPH_APP_PORT` / `RALPH_DB_PORT` | ports (auto-allocated if not passed) |
| `RALPH_PREVIEW_URL` | `http://<host>:<app-port>` (or whatever `preview-url.sh` prints) |
| `RALPH_COMPOSE_PROJECT` | isolated docker-compose project name |

Ports come from `--app-port`/`--db-port` or are auto-allocated. Hostname defaults
to `localhost` (`--preview-host` or config `preview.host`); for the apps VM use
`--preview-host apps` so the URL is `http://apps:<app-port>`. Per-iteration preview
artifacts are saved: `preview_up_N.log`, `preview_url_N.txt`, `e2e_N.log`, and
`preview_down_N.log` if teardown runs.

### Operator commands: status / integrate / cleanup

```bash
ralph status    --repo /path/to/target                 # summarize latest run
ralph integrate --repo /path/to/target --run latest    # merge an APPROVED run
ralph cleanup   --repo /path/to/target --run latest     # remove worktree / stop preview
```

Each run writes `<target>/.ralph/last-run.env` (RUN_ID, STATUS, BRANCH, WORKTREE,
BASE_COMMIT, PREVIEW_URL, ARTIFACTS_DIR) so these commands can find it; `--run`
accepts `latest` or a specific run id.

`ralph integrate` is conservative: it refuses unless the run is
`READY_FOR_HUMAN_REVIEW` (override with `--force`), refuses if the target is dirty,
shows a diff summary, merges the run branch into the current branch with
`git merge --no-ff`, re-runs the check, and **never pushes**.

On a successful merge **and** a passing post-merge check, `integrate` then
**automatically cleans up that run by default**: it stops the preview and removes
the worktree, **keeping the branch**. Safety rails:

- a failed merge → no cleanup (resolve conflicts manually);
- a failed post-merge check → no cleanup (worktree/preview left for debugging);
- a dirty worktree → cleanup refuses to remove it unless `--force`;
- the branch is never deleted automatically (only `--delete-branch` does that);
- nothing is ever pushed.

Opt out of the auto-cleanup with `--keep-worktree` (alias `--skip-cleanup`). After
a kept worktree you can clean up later with `ralph cleanup`. `ralph cleanup`
removes the worktree (refuses a dirty one without `--force`), optionally stops the
preview, and keeps the branch unless `--delete-branch`.

### Operate from a coding agent (`ralph install-agent-commands`)

```bash
ralph install-agent-commands     # v1: Claude Code -> ~/.claude/commands/
```

Installs `/ralph-review`, `/ralph-status`, `/ralph-integrate`, `/ralph-cleanup`
slash-commands that teach the agent to *drive* the harness (run it, summarize,
ask before integrating) rather than reimplement it. Existing files are kept unless
`--force`. See **[docs/agent-operator.md](docs/agent-operator.md)** for the full
operator playbook (harness vs target, roles vs backends, expected agent behavior).

### Intended website workflow

```bash
# 1. one-time: scaffold + author a PRD + fill in preview/e2e scripts
ralph init-target --repo /path/to/target --type nextjs-postgres

# 2. run the adversarial loop with preview validation
ralph review 1 --repo /path/to/target --builder opencode-z --reviewer claude --preview
#    harness: worktree -> builder -> check -> preview-up -> e2e -> reviewer (loop)

# 3. if READY_FOR_HUMAN_REVIEW, open the printed preview URL and review the diff
ralph status --repo /path/to/target

# 4. after you approve, integrate and clean up (never auto-merged/pushed)
ralph integrate --repo /path/to/target --run latest
ralph cleanup   --repo /path/to/target --run latest
```

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
