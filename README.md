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
AGENT_CMD="claude -p --dangerously-skip-permissions"
AGENT_CMD="droid exec --skip-permissions-unsafe -f {prompt}"
AGENT_CMD="opencode run"
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

#### Configure agents locally (`config.local.sh`)

Don't edit the tracked config for machine-specific setup — the agent binaries you
have, the exact command that runs them, your default roles. Put those in an
**untracked** `config.local.sh` instead:

```bash
cp .agents/ralph/config.local.sh.example .agents/ralph/config.local.sh
# then edit — e.g. define a backend the harness doesn't ship with:
#   AGENT_ZLAUDE_CMD='zlaude -p --dangerously-skip-permissions "$(cat {prompt})"'
#   : "${BUILDER:=zlaude}"        # your default builder (a --builder flag still wins)
```

`config.local.sh` is git-ignored and sourced **last**, so it overrides the shipped
defaults without merge conflicts or leaking your setup. Precedence, highest first:
**CLI flag → env var → `config.local.sh` → `config.sh`/`review-config.sh` →
`agents.sh` defaults.** A backend is just an `AGENT_<NAME>_CMD` whose template
contains `{prompt}` (a quoted prompt-file path is substituted) or reads the prompt
from stdin — see `config.local.sh.example` for the full set of examples.

When normalized selection supplies an explicit model for a custom wrapper, Ralph
requires the wrapper command and the role setting to agree and composes exactly one
model selector. Z.AI's usage API may normalize model names, so one model name in its
usage report does not by itself confirm that the requested pin was honored.

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

### Common pitfalls (target setup)

One-time target-setup gotchas hit when driving real repos through the batch loop.

1. **Commit the `init-target` scaffolding to the target's `main` before the first
   run.** `ralph init-target` writes the `.gitignore` entries (`.ralph/`,
   `.agent-run/`, `.agent-handoff.md`, `.agents/ralph/config.local.sh`),
   `ralph.target.json`, and `scripts/check.sh` to the *working tree* — it does not
   commit them. Batch worktrees branch off the target's **committed** `main`, so if
   these aren't committed the worktree's `.gitignore` lacks the artifact entries and
   the builder's `git add -A` stages the harness artifacts (`.agent-handoff.md`,
   `.agent-run/`) into the task diff. Commit them with a one-line chore PR first.

2. **`CHECK_CMD` / `VERIFY_CMD` must be a single command or a script path.** The loop
   runs them via `eval "$CMD"`. An inline shell **brace-group `{ ...; }`** or
   command substitution `$(...)` in that string is truncated at the `}`, leaving an
   unterminated group → `syntax error: unexpected end of file` on *every* attempt —
   a vacuous, code-independent failure that retries until `MAX_ITERATIONS` even when
   the work is correct and the reviewer voted `VERDICT: PASS`. Put complex check
   logic in a script and point the variable at its path (e.g.
   `CHECK_CMD=/path/to/my-check.sh`). Keep acceptance (`VERIFY_CMD`) simple too
   (`! grep ...`, `npm test -- foo`) or route it through a script. (Same `}` caveat
   as the `{prompt}` note in `agents.sh`.)

3. **Worktrees lack gitignored deps; don't paper over it with a symlink.** A worktree
   is a fresh `git worktree add`, so gitignored dirs (`node_modules/`, `venv/`,
   `target/`) are absent. If your check needs them, **copy** them into the worktree
   (e.g. `cp -a "$MAIN/node_modules" node_modules`, or `cp -al` for a fast hardlink
   copy when the check only reads). Do **not** `ln -s`: a symlink named
   `node_modules` is *not* matched by a `node_modules/` (dir-only) gitignore pattern,
   so `git add -A` stages the symlink — an absolute, machine-specific path — into the
   diff. A real directory is matched and ignored.

### Scaffold a target repo (`ralph init-target`)

```bash
ralph init-target --repo /path/to/target                  # generic
ralph init-target --repo /path/to/target --type nextjs-postgres
```

Creates `.agents/tasks/`, a `ralph.target.json` config, `scripts/check.sh`, adds
`.ralph/`, `.agent-run/`, `.agent-handoff.md`, and `.agents/ralph/config.local.sh`
to `.gitignore`, and (for `nextjs-postgres`) adds
executable `scripts/preview-up.sh`, `preview-down.sh`, `preview-url.sh`, `e2e.sh`
templates. Existing files are not overwritten unless you pass `--force`.

### Target config (`ralph.target.json`)

Committed to the **target** repo. CLI flags override it; it overrides the
built-in defaults.

```json
{
  "check": "./scripts/check.sh",
  "preflight": {
    "enabled": true,
    "install": "npm ci",
    "check": "./scripts/check.sh",
    "test": "npm test",
    "e2e": ""
  },
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

### Preflight (repo contract)

Before `build` / `review` / `batch` creates any worktree or starts any agent,
Ralph runs a **preflight** phase against the current checkout to confirm the
baseline repo is healthy — so a broken repo never burns an agent run.

- Configure ordered steps under `preflight` in `ralph.target.json`: `install`,
  `check`, `test`, `e2e` (each optional), plus an optional `commands: [...]` list.
  Steps run **fail-fast** in the target repo; the first failure blocks the run.
- A preflight failure **blocks**: no worktree is created, no agent runs, the run
  exits with status **3** and `STATUS=PREFLIGHT_FAILED` in `.ralph/last-run.env`,
  and a report is written to the run's `preflight.md`.
- It's a no-op (pass) if there's no `preflight` block, `enabled` is `false`, or you
  pass `--no-preflight` (alias `--skip-preflight`).
- Run it on its own anytime: `ralph preflight --repo /path/to/target`.

When preflight fails, the repo *contract* is broken, not the task — operator agents
are instructed to propose the minimal repo-contract fix rather than implement PRDs.

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
ralph install-agent-commands              # interactive: pick the agent
ralph install-agent-commands --agent codex   # non-interactive
```

Installs `/ralph-review`, `/ralph-status`, `/ralph-integrate`, `/ralph-cleanup`
commands that teach the agent to *drive* the harness (run it, summarize, ask before
integrating) rather than reimplement it. The commands are authored once (canonical
markdown in `agent-commands/ralph/`) and adapted per agent at install time:

| `--agent` | Installs to | Format |
| --- | --- | --- |
| `claude` (default) | `~/.claude/commands/<name>.md` | Claude slash commands (`$ARGUMENTS`) |
| `codex` | `~/.codex/prompts/<name>.md` | Codex slash commands (frontmatter stripped) |
| `copilot` | VS Code user prompts¹ `<name>.prompt.md` | Copilot prompt files (`${input:args}`) |

¹ `~/.config/Code/User/prompts/` (Linux), `~/Library/Application Support/Code/User/prompts/`
(macOS), `%APPDATA%\Code\User\prompts\` (Windows).

Re-running **updates** the installed commands (content-aware — unchanged files are
left alone, changed ones are refreshed, new ones added), so this is also how you push
command updates to your agents. Add another agent by adding one entry to
`AGENT_TARGETS` in `bin/ralph`. See **[docs/agent-operator.md](docs/agent-operator.md)**
for the full operator playbook (harness vs target, roles vs backends, expected
agent behavior).

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

### Batch mode: many tasks, one shared worktree (`ralph batch`)

`ralph review` runs **one** task per worktree. `ralph batch` runs **many** tasks
**sequentially on a single shared branch + worktree**, so later tasks build on
earlier ones — ideal for working a backlog unattended (e.g. overnight).

```bash
ralph batch \
  --repo /path/to/target \
  --plan ./prds \
  --builder claude --reviewer codex \
  --check ./scripts/check.sh \
  --max-tasks 10 \
  --auto-approve-builder \
  --stop-on-fail
```

- `--plan` is a **directory of `*.md` tasks** (run in sorted filename order) or a
  **single `.md` file** split into tasks at its shallowest heading level.
- One branch/worktree `ralph/batch-<timestamp>` is created for the whole batch.
  Per task: builder → check → reviewer (read-only), retried up to `--max-iterations`
  (default 5) with feedback, then committed once on the branch. Failed tasks are
  kept (so later tasks can build on them) and clearly marked; `--stop-on-fail`
  halts at the first failure instead.
- `--auto-approve-builder` lets the **builder** edit unattended (permission-skipping
  flags; logged explicitly). It **never** affects the reviewer, which always runs
  read-only (sandboxed for Codex). Without it the builder runs in manual mode.
- `--max-tasks <n>` caps how many tasks run (default: all).
- **`--verify <cmd>` — acceptance gate (a heavier check at PASS-time).** The
  per-attempt `--check` should be fast (lint, typecheck, unit tests) so iteration is
  cheap. `--verify` (or `ralph.target.json` `.verify`) runs a heavier command — full
  suite, production build, or an issue's **Acceptance** criteria — **only once per
  task**, when the fast check passed *and* the reviewer voted PASS. If verify fails,
  the task is not accepted: its log is fed back to the builder as `{{PREVIOUS_VERIFY}}`
  and it iterates. Empty = disabled (default). Whole-system e2e still belongs in the
  end-of-batch preview lifecycle, not here.
- **`--primer <file>` — orchestrator-supplied repo orientation.** Renders into a
  `{{PRIMER}}` slot at the top of every builder prompt (run-scoped; no need to edit
  the target's `AGENTS.md`). Use it to inject a repo map / conventions / "where to
  look" so the builder doesn't re-derive structure each attempt. Also settable as
  `ralph.target.json` `.primer` (path relative to the target repo). An unset,
  missing, or empty primer emits a soft warning in the banner, preflight artifact,
  and final report but does not stop the batch. For an intentional no-primer run,
  set `RALPH_PRIMER_OPTOUT=1` to silence the warning and record the deliberate opt-out.
- **Agent ERROR vs task FAIL.** A *task* FAIL means the reviewer voted FAIL / checks
  failed. An *agent* ERROR is a tooling outage the harness detects — the backend
  exits non-zero, or the reviewer emits no `VERDICT:` line (a missing verdict is
  **ERROR, never FAIL**). On ERROR the offending agent is retried up to
  `RALPH_AGENT_RETRIES` times (default 2) with exponential backoff; if it still
  errors the **whole batch halts** with `REVIEWER_UNAVAILABLE` / `BUILDER_UNAVAILABLE`
  (exit 4, distinct from `COMPLETED_WITH_FAILURES`), a re-login hint, and a resume
  command. No builder attempt is consumed and the error output is never fed back.
  A terminal provider window instead halts immediately as
  `PROVIDER_QUOTA_EXHAUSTED`, recording its provider and reset time. The configurable
  `RALPH_QUOTA_REGEX` ERE defaults to explicit
  `usage limit reached ... reset at YYYY-MM-DD HH:MM:SS` responses, so an ordinary
  transient 429 does not open the circuit breaker. Pool identity defaults to the
  provider name and can be set with `RALPH_BUILDER_CREDENTIAL_POOL` /
  `RALPH_REVIEWER_CREDENTIAL_POOL` when backend names share credentials. Open pools
  are skipped for the rest of the run; unrelated pools remain dispatchable, and a
  parsed elapsed reset time closes the circuit automatically.
- **Proactive token ceiling.** Set `RALPH_ORCHESTRATOR_BUDGET_TOKENS` to stop the
  batch cleanly once cumulative builder+reviewer usage reaches that value. An
  optional `RALPH_ORCHESTRATOR_STOP_PCT` (default `100`) applies a percentage to
  the ceiling. The completed round's usage is flushed first, then the batch ends as
  `ORCHESTRATOR_BUDGET_REACHED` with the configured budget, percentage, observed
  total, and unknown-round count in `last-run.env` and the terminal banner. Unknown
  totals count as zero without being replaced; with no budget the feature is off.
- **Task BLOCKED (needs a human).** Beyond PASS/FAIL, the reviewer may vote
  `VERDICT: BLOCKED` when a task is well-defined but not completable *in scope* —
  contradictory/impossible acceptance, needs access or a product decision, or an
  out-of-scope architectural change. BLOCKED is **terminal for that task**: it
  short-circuits the retry loop (no point burning attempts), commits the partial work
  plus the reviewer's blocker report, and — if no task hard-failed — the batch ends
  `COMPLETED_WITH_BLOCKERS`. Guardrails: the builder can only *request* it via its
  handoff; the read-only reviewer decides, and a missing/empty verdict is `ERROR`,
  never inferred as BLOCKED. Especially useful in bug/issue mode, where a "bug" often
  turns out to need a human decision. After you unblock it, `--resume` retries it.
- **Resume.** After fixing/re-authenticating the backend (or unblocking a task),
  `ralph batch … --resume` reuses the same branch+worktree, **skips tasks that already
  PASSed** (kept as commits), and continues from where it halted — so an outage never
  forces you to redo completed tasks. (Also exposed to agents as `/ralph-resume`.)
- Guardrails: refuses a dirty target unless `--allow-dirty`; runs preflight first;
  prints the full plan (repo, branch, worktree, builder, reviewer, check, flags)
  before starting; never merges, pushes, or deletes anything.

Artifacts go to `<target>/.agent-run/batch-<timestamp>/`:

```
.agent-run/batch-<timestamp>/
  config.resolved.env        tasks/manifest.tsv  tasks/task-NNN.md
  task-NNN-builder-prompt.md task-NNN-builder.log
  task-NNN-check.log         task-NNN-diff.patch task-NNN-handoff.md
  task-NNN-reviewer.md       task-NNN-result.md
  batch-context.md           final-report.md
```

The `final-report.md` lists tasks attempted/completed, per-task files changed,
checks, reviewer verdicts, failures/blockers, and suggested human-review steps. The
batch also writes `<target>/.ralph/last-run.env`, so `ralph status` / `ralph integrate`
/ `ralph cleanup` work on the batch branch just like a single review run. Add it to
your operator agent with `/ralph-batch` (installed by `ralph install-agent-commands`).

### Efficiency profile + `ralph explain` (opt-in, default OFF)

An **efficiency profile** is the operator's declarative cost policy: a ladder of
**rungs** (cheapest first), the **credential pool** each role draws on, the window
caps / avoid-windows that make a pool ineligible, the reserves to keep for
higher-value work, and which rungs each task complexity may use.

Copy the shipped example and edit it:

```bash
cp .agents/ralph/efficiency.json.example .agents/ralph/efficiency.json
```

The real `efficiency.json` is **gitignored** (it is local operator policy, like
`config.local.sh`); only the `.example` ships. Point elsewhere with
`--efficiency-profile <path>` or `RALPH_EFFICIENCY_PROFILE`.

Ask what the policy *would* do — read-only, dispatches nothing:

```bash
ralph explain --complexity medium [--repo <target>] [--profile <path>] [--json]
```

It prints the tier's allowed rungs in order, then per pool: the window caps, whether
an avoid window is active *now* (compared against the current UTC time), the reserve,
and any near-weekly-reset relaxation — then the rung it would choose and why.

#### Where the per-pool usage numbers come from

`.agents/ralph/usage-state.sh` (and the `usage-state.py` behind it) is the read-only
reader that feeds `explain`. It is a **local estimate** — it calls no provider usage
API, it only sums what the harness itself wrote to `<target>/.ralph/ledger.jsonl`:

```bash
.agents/ralph/usage-state.sh --repo <target> [--profile <path>] [--json]
```

For every pool the rungs reference it reports, per window (rolling 5 h and the
current week), a normalized record: `{pool, window, used_tokens, budget_tokens,
pct, reset_at, in_avoid_window, source}`.

- **pct only with a budget.** Add `window_5h_budget_tokens` /
  `window_weekly_budget_tokens` to a pool's cap block and the token sums become a
  percentage. Without one there is no denominator, so `pct` is `unknown` and only
  the raw token count is reported — a percentage is never invented (the hard
  quota circuit remains the real backstop).
- **Reset proximity.** The 5 h reset is when the oldest in-window record ages out.
  The weekly window (and its reset, and `near_weekly_reset` vs
  `reserves.near_weekly_reset_hours`) needs `weekly_reset_anchor` — an ISO-8601 UTC
  instant the week repeats from. Without it the week is a rolling 7 d and the reset
  is `unknown`.
- A `quota` block on a ledger record
  (`{pool, window_5h_pct, window_weekly_pct, weekly_reset_at}`) still wins over the
  local estimate for that pool. With no ledger, no budget and no quota block,
  `explain` assumes **0 % used** and says so.

The reader writes nothing: the ledger and the profile are untouched, and it enforces no
cap or reserve of its own — it only supplies the numbers the selection is made from.

#### How a rung is chosen

`explain` and the selection function are the same code. In shell it is
`ralph_efficiency_select <complexity> [<target>]` (source `.agents/ralph/efficiency.sh`),
which reports its decision in `RALPH_EFFICIENCY_SELECT_RUNG` / `_BUILDER` / `_REVIEWER`
/ `_REASON` and returns **0** on a selection, **3** on a bounded pause and **4** when
efficiency is inert. It walks the tier's rungs in order and takes the first eligible
one; a rung is eligible only if every pool it draws on is:

- **outside an avoid window** right now (current UTC day + time);
- **not tripped in the hard quota circuit** — the `ralph_quota_pool_is_exhausted`
  circuit from the provider-exhaustion path, reused as-is (an elapsed reset closes it);
- **under its window caps** and **above the weekly reserve it carries** (the sum of
  the reserves of every control-plane role that runs on it — see below).

Three rules are deliberate:

- **The reserves follow the control-plane ROLE, not the pool.** `reserves` is keyed
  by role — `manager_pct` (25) and `orchestrator_pct` (50) — and each role's reserve
  is applied to whichever pool that role actually runs on: the **orchestrator**'s
  pool is the one behind `RALPH_CRON_DRIVER` (resolved by `ralph_resolve_cron_driver`,
  then mapped backend → pool through the profile's own rungs), the **manager**'s is
  `RALPH_MANAGER_POOL` or, unset, the `anthropic` pool (it runs on the strongest
  Claude by charter). Point the driver at zai and zai carries the 50 %; point it at
  codex and the openai pool does instead, while zai reverts to its plain caps. When
  both roles share a pool their reserves **stack** on it (25 + 50 = 75 %). A pool no
  role runs on has no reserve at all.
- **The reserves are enforced in code.** The profile supplies the numbers, but
  omitting `reserves.manager_pct` / `orchestrator_pct` does not switch the reserve
  off — the built-in 25 % / 50 % (and `near_weekly_reset_hours` of 5) apply.
  Within that many hours of the **weekly** reset both weekly gates (cap and reserve)
  are relaxed: quota about to expire is quota you may as well spend. The rolling 5 h
  cap is never relaxed.
- **Unknown usage fails open.** With no budget and no quota observation there is no
  percentage, and a missing number must never freeze the ladder: the pool stays
  eligible and the hard circuit remains the real gate.

If no rung of the tier is eligible, the `backstop: true` rung (deepseek) is used even
when the tier does not list it — it is exempt from caps and reserves, and only its own
circuit or avoid window can take it out. If even that is unavailable the result is a
distinct **bounded PAUSE** (a retry instant, never longer than the 5 h window), never a
crash and never a silent selection.

Validation is **reject-to-safe**: a malformed or invalid profile is rejected with a
loud warning on stderr and efficiency mode falls back to inert/off — it never crashes
or fails a run, and it never enforces part of a policy it could not parse. A missing
profile prints a clean "not configured" message.

#### Turning it on: `--efficiency` (default OFF)

`--efficiency` (or `RALPH_EFFICIENCY=1`) on `ralph review` / `ralph batch` boot-validates
the profile and then right-sizes **each ticket** from it: before dispatching a ticket the
loop reads its complexity (a `complexity:<tier>` label, or the `complexity` field / a
`complexity:` label on the PRD story) and applies the rung `ralph_efficiency_select`
picks, overriding `--builder` / `--reviewer` for that ticket only. The chosen rung, the
pools and the reason land in the run (`efficiency-dispatch.jsonl`, `final_status.md` /
`final-report.md`, the per-task result file used for the PR body), in `last-run.env`, and
in the `efficiency` block of the `.ralph/ledger.jsonl` record for that round.

**Default OFF is the contract.** Without the flag none of that code runs: dispatch is
exactly `--builder` / `--reviewer` (plus `config.local.sh`), with no extra output and no
extra ledger field — `tests/efficiency-select.mjs` pins that as a regression test.

Three ways it steps aside rather than surprising you:

- **Ticket with no `complexity:<tier>`** — nothing to right-size by, so the operator's
  own selection runs, with a loud warning.
- **Missing or malformed profile** — inert fallback to normal dispatch and a loud
  warning; never a crash.
- **No eligible rung (not even the backstop)** — a clean, bounded pause instead of
  dispatching something the policy forbids: terminal status `EFFICIENCY_PAUSED`, exit
  **5**, artifacts preserved, reason + retry instant published. In a batch the tasks
  already completed stay committed with their usage flushed, and `--resume` picks up
  from there; in a review nothing has been created yet, so the target repo is untouched.

#### Climbing the ladder: `--auto-escalate` (default OFF)

`ralph review --efficiency --auto-escalate` (or `RALPH_AUTO_ESCALATE=1`) changes what
"the iterations ran out" means. Each rung gets its own budget —
`--escalate-iterations`, default **3** — and a rung that spends it without a `VERDICT:
PASS` is **promoted** to the next stronger *eligible* rung of the tier ladder and
retried with a fresh budget. The reviewer's must-fix feedback is carried across the
promotion, so the stronger builder starts from what the cheaper one learned.

Eligibility is not relaxed to make a promotion possible: the same avoid windows, caps,
`#28` quota circuits and role reserves that `ralph_efficiency_select` enforces still
apply, so an ineligible rung is skipped over rather than used.

It is **bounded by construction** — a promotion only ever looks *above* the rung that
just failed, so the ladder strictly shrinks:

- a PASS at any rung ends the run normally (`READY_FOR_HUMAN_REVIEW`);
- when the strongest eligible rung (or the deepseek backstop) has been tried and still
  fails, the run ends on `FAILED_ESCALATION_EXHAUSTED` (exit **2**) naming every rung
  in the order it was tried: `cheap -> mid -> strong -> backstop (all failed)`.

Each promotion (`from -> to`, reason, the iteration it happened after) is recorded in
`<run>/escalations.jsonl`, in `<target>/.ralph/ledger.jsonl` as an `event` record — which
`ralph report` skips, since it is not a usage round — and in the run banner,
`final_status.md` (the PR/handoff body) and `last-run.env`.

**Default OFF is the contract here too.** Without `--auto-escalate` a spent budget is
still `FAILED_MAX_ITERATIONS`, byte-for-byte. And with the flag but no rung ladder
(efficiency off/inert, or a story with no `complexity:<tier>`) there is nothing to climb,
so it degrades to a **no-op with a note** — `tests/auto-escalate.mjs` pins both.

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
