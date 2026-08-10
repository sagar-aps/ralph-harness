# Operating the Ralph harness (agent / human operator guide)

This guide is for whoever sits in the **pilot seat** driving the harness — a human
in a terminal, or a coding agent such as Claude Code, Codex, Cursor, etc. It is
intentionally generic; a Claude Code–specific section is at the end.

## Harness repo vs target repo

- **Harness repo** (this repo): the loop tooling the **orchestrator role** operates —
  it owns the loop, the prompts, the backends, and the operator commands. (The
  orchestrator is a *role*, a mid-tier agent; this repo is what it drives. See the
  [architecture](architecture.md) for the full five-role picture.) It is *not* the
  project being built.
- **Target repo**: a *separate* git repo that contains the actual application,
  its PRD/tasks (`.agents/tasks/*.json`), its `AGENTS.md`/`CLAUDE.md`, its
  `scripts/check.sh`, and (optionally) website preview/e2e scripts plus a
  `ralph.target.json` config.

The harness runs every agent/check/preview command with its working directory set
to a **git worktree of the target repo**. The harness never edits the target's
source except through that worktree, and **never merges to the target's main
branch**. Integration is a separate, explicit, human-approved step.

## Roles vs backends

- A **role** is a job in the loop: `builder` (edits code) or `reviewer`
  (read-only judge). More roles may be added later.
- A **backend** is a concrete agent CLI: `claude`, `codex`, `opencode`,
  `opencode-z`, `codex-readonly`, … or any `AGENT_<NAME>_CMD` you define.
- Roles and backends are decoupled. Assign them per run with `--builder` /
  `--reviewer`, or in `.agents/ralph/review-config.sh`.

## Installing the harness (recommended: local link)

Run this once from your clone so the `ralph` command points at your checkout:

```bash
cd /path/to/ralph-harness   # the directory where you cloned this repo
npm link
```

After that, use `ralph ...` directly from anywhere (it always reflects your local
edits — no publish/reinstall needed).

## One-time setup of a target

```bash
ralph init-target --repo /path/to/target            # generic
ralph init-target --repo /path/to/target --type nextjs-postgres   # + preview/e2e
```

This creates `.agents/tasks/`, `ralph.target.json`, `scripts/check.sh` (and the
preview scripts for `nextjs-postgres`), and adds `.ralph/` + `.agent-handoff.md`
to `.gitignore`. It also installs the **Manager role skill** at
`.claude/skills/manager/SKILL.md` (plus the canonical `LABELS.md`) — see
[Managed mode](#managed-mode) below. Then add a PRD JSON under `.agents/tasks/` and
fill in the scripts.

`init-target` never overwrites an already-present manager charter (the Manager fills
in its per-repo "Project facts" on first run and edits the file in place); pass
`--force` only if you deliberately want to reset installed files to the templates.

## Managed mode

> **Read first:** [modes.md](modes.md) picks *which* setup you want (unmanaged vs.
> managed); [architecture.md](architecture.md) is the full five-role picture (Owner /
> Manager / Orchestrator / Builder / Reviewer across three model tiers, with diagrams).
> This section is the operator's how-to for the managed setup.

Managed mode is the autonomous setup: a frontier **Manager** inside the target repo and a
mid-tier **Orchestrator** above it drive the builder/reviewer loop, so no human sits in the
arbitration path. The two agents share one contract — the
[label protocol](../.agents/ralph/references/LABELS.md) plus per-issue `## Acceptance`
sections the Manager verifies against deployed reality.

- **Manager** (frontier, *in* the repo) — owns `## Acceptance`, reviews the PRs the
  Orchestrator files, gates merge + prod deploy, investigates and creates ready tickets.
- **Orchestrator** (mid, *above* ralph + the target) — its hourly loop picks `now` +
  `spec:ready` tickets, dispatches builders/reviewers through this harness, dev-verifies,
  files PRs, and routes arbitration + emergent findings up to the Manager. It **never asks
  the human** and **never deploys prod**.
- **Builder / Reviewer** — the harness's dispatched workers; unchanged from the unmanaged
  loop. The builder reports up to the Orchestrator (it never contacts the Manager).

**Install the Manager skill.** `ralph init-target` (above) drops the Manager charter into
the target repo at `.claude/skills/manager/SKILL.md`, with a co-located copy of the
[label protocol](../.agents/ralph/references/LABELS.md). It is bootable from a cold session
with no reading of the ralph harness, and is never overwritten once filled in.

**Boot the Manager.** Open a Claude session *in the target repo* and type `/manager`: on
first run it fills the charter's "Project facts" section (deploy entrypoints, environments,
required CI check, secret traps, denied operations) and creates the protocol labels; on
later runs it reconstructs state from GitHub alone (`gh pr list`, `gh issue list --label
now`, latest CI, `git log`).

**Boot the Orchestrator.** Open a *separate*, mid-tier session at a level that sees **both**
this harness and the target repo, and point it at its charter
([`.agents/ralph/ORCHESTRATOR.md`](../.agents/ralph/ORCHESTRATOR.md)) — e.g. "you are the
orchestrator, initialize target `<path>`, tickets are at `<where>`, go." It runs
`ralph init-target`, then loops: read the Manager's comments, select eligible tickets,
dispatch them via `ralph review` / `ralph batch`, dev-verify, and file PRs. It does **not**
read the target's internals — repo knowledge lives with the Manager and Builder.

**Identity prerequisite.** The hard gate depends on two distinct GitHub identities — a
Manager identity (GitHub App / machine account) and an Orchestrator/builder identity — so the
Manager can formally approve/merge what the Orchestrator cannot. Without them the Manager
falls back to review-comment + squash-merge, which works and keeps the audit trail but gives
no enforced approval gate. Set the identities up separately; nothing in managed mode
hard-requires them.

## Preflight (repo contract)

Before `build` / `review` / `batch` makes a worktree or starts an agent, Ralph runs
a **preflight** phase against the baseline checkout — the repo's configured
`install` / `check` / `test` / `e2e` (set under `preflight` in `ralph.target.json`).
If any step fails, the run is **blocked**: no worktree, no agents, exit status 3,
`STATUS=PREFLIGHT_FAILED` in `.ralph/last-run.env`, and a `preflight.md` report.

Run it on its own with `ralph preflight --repo <target>`; bypass it with
`--no-preflight`.

**Operator behavior on preflight failure:** a failing preflight means the repo
*setup* is broken, not the task. Do **not** implement PRDs or bypass preflight to
push work through. Read the `preflight.md` report and propose the **minimal
repo-contract fix** (a corrected install/test command, a missing dependency or
script, a broken baseline check) for the human to apply, then re-run once the
contract is green.

## Running a review

```bash
ralph review <task> --repo /path/to/target --builder opencode-z --reviewer claude
```

- `<task>` is a 1-based index into the actionable open stories, or use
  `--task US-001` to pick by id.
- Add `--preview` to force the website preview + e2e pipeline on (or rely on
  `ralph.target.json`'s `preview.enabled`). Add `--no-preview` to force it off.
- The loop runs: **builder → check → (preview-up → preview-url → e2e) → reviewer**,
  repeating on failure up to `--max-iterations` (default 5).

It ends in one of two states:

- **`READY_FOR_HUMAN_REVIEW`** — the check passed, preview/e2e passed (if enabled),
  and the reviewer returned `VERDICT: PASS`. The work is on an unmerged
  `ralph/<task>-<run-id>` branch in a worktree. Nothing was merged.
- **`FAILED_MAX_ITERATIONS`** — it could not reach a passing state in the allotted
  iterations. Inspect the artifacts, adjust, and re-run.

With `--auto-escalate` (opt-in, default OFF) there is a third ending. Instead of
stopping at `FAILED_MAX_ITERATIONS`, a rung that spends its per-rung budget
(`--escalate-iterations`, default 3) is promoted to the next **stronger eligible**
rung of the efficiency ladder and retried with a fresh budget, carrying the
reviewer's must-fix feedback forward:

- **`FAILED_ESCALATION_EXHAUSTED`** — every rung up to the strongest eligible one
  (or the backstop) was tried and none passed. The banner, `final_status.md` and
  `last-run.env` name the rungs in the order they were tried; each promotion is
  also recorded in `<run>/escalations.jsonl` and `<target>/.ralph/ledger.jsonl`.

Escalation needs the `--efficiency` rung ladder (the story must carry a
`complexity:<tier>`). Without one, `--auto-escalate` is a no-op with a note and the
run ends at `FAILED_MAX_ITERATIONS` exactly as it does today.

`ralph batch` has a second, independent escalation trigger that needs **no flag beyond
`--efficiency`**: a builder/reviewer backend that fails to LAUNCH (backend-unavailable
ERROR, or a rung whose backend is not installed) promotes the TASK up the same ladder
instead of halting the batch, and ends on `LAUNCH_ESCALATION_EXHAUSTED` (exit 4,
resumable) only once every rung has failed to launch. See docs/OPERATING.md §6.1.

## Running a batch (many tasks, one shared worktree)

For a backlog of tasks in one unattended run, use `ralph batch`. It creates ONE
branch/worktree `ralph/batch-<timestamp>` and runs tasks **sequentially** on it, so
later tasks build on earlier ones.

```bash
ralph batch --repo /path/to/target --plan ./prds \
  --builder claude --reviewer codex \
  --max-tasks 10 --auto-approve-builder --stop-on-fail
```

- `--plan` is a directory of `*.md` tasks (sorted) or one `.md` file split at its
  shallowest heading level.
- Per task: builder → check → reviewer (read-only) → record → commit on the branch.
- `--auto-approve-builder` lets the builder edit unattended; it never affects the
  reviewer (always read-only). Without it the builder runs in manual mode and will
  likely stall waiting for approval — so pass it for overnight runs.
- `--stop-on-fail` halts at the first failing task; otherwise failures are marked
  and the batch continues.
- Artifacts + `final-report.md` land in `<target>/.agent-run/batch-<timestamp>/`.
  The batch writes `<target>/.ralph/last-run.env`, so `status` / `integrate` /
  `cleanup` work on the batch branch exactly like a single review run.

Read the `final-report.md`, summarize for the human, and **ask before integrating**.
Nothing is ever merged, pushed, or deleted.

## Inspecting status

```bash
ralph status --repo /path/to/target
```

Reads `<target>/.ralph/last-run.env` and the run's `final_status.md` /
`config.resolved.env`, and prints the outcome, branch, worktree, preview URL,
artifacts dir, and a diff summary. Per-iteration artifacts live in
`<target>/.ralph/runs/<run-id>/` (prompts, outputs, check/preview/e2e logs,
diffs, handoff snapshots).

For website runs, open the printed **preview URL** in a browser to validate the
change visually before integrating.

## Integrating approved work

Integration is conservative and only after a human approves:

```bash
ralph integrate --repo /path/to/target --run latest
```

It refuses unless the run is `READY_FOR_HUMAN_REVIEW` (override with `--force`),
refuses if the target is dirty, shows a diff summary, merges the run branch into
the target's current branch with a normal `git merge --no-ff`, and re-runs the
check command afterward. It **never pushes** — push yourself when ready. Preview/
e2e are not re-run on integrate by default (re-run `ralph review` if you want to
re-validate the merged result).

**Default cleanup:** on a successful merge *and* a passing post-merge check,
`integrate` automatically cleans up that run — it stops the preview and removes the
worktree, **keeping the branch**. It prints what it did (preview stopped / worktree
removed / branch kept) and the command to delete the branch if you want to. Safety:
a failed merge or a failed post-merge check skips cleanup (worktree/preview left for
debugging), a dirty worktree is not removed without `--force`, and the branch is
never deleted unless you pass `--delete-branch`. Pass `--keep-worktree` (alias
`--skip-cleanup`) to integrate without the auto-cleanup.

## Cleaning up worktrees / previews

```bash
ralph cleanup --repo /path/to/target --run latest
```

Removes the run's worktree (refuses if it has uncommitted changes unless
`--force`) and runs the preview-down script if the target config defines one. It
keeps the branch by default — pass `--delete-branch` to remove it.

## Expected operator behavior (generic)

1. **Do not bypass the harness** to implement the PRD/story yourself, unless the
   human explicitly asks you to. The whole point is the adversarial loop.
2. **Run the harness** (`ralph review …`) and let it iterate.
3. **Summarize the result** for the human: outcome, branch, preview URL, the key
   reviewer findings, and where the artifacts are.
4. **Ask the human before integrating.** Never integrate or push on your own.
5. **Integrate only after explicit approval**, with `ralph integrate`. Then offer
   to clean up.

## Installing operator commands into your coding agent

Install the operator commands once. The same four commands are adapted per agent:

```bash
ralph install-agent-commands              # interactive menu (Claude Code / Codex / Copilot)
ralph install-agent-commands --agent codex
ralph install-agent-commands --agent copilot
```

| Agent (`--agent`) | Installs to | Invoke as |
| --- | --- | --- |
| `claude` (default) | `~/.claude/commands/` | `/ralph-review` … in Claude Code |
| `codex` | `~/.codex/prompts/` | `/ralph-review` … in Codex (CLI/IDE) |
| `copilot` | VS Code user prompts folder (`*.prompt.md`) | `/ralph-review` … in Copilot Chat |

This gives you:

- `/ralph-review <task> --repo <path> [--builder …] [--reviewer …] [--preview]`
- `/ralph-status --repo <path>`
- `/ralph-integrate --repo <path> [--run latest|<id>]`
- `/ralph-cleanup --repo <path> [--run latest|<id>] [--delete-branch]`

These commands teach the agent to *operate* the harness, not to reimplement it.
When acting as the operator, the agent should:

- Run `/ralph-review` instead of editing the target repo directly.
- After the run, read `<target>/.ralph/last-run.env` + the run's `final_status.md`
  and summarize.
- For website tasks, surface the **preview URL** and suggest the human open it.
- Stop at `READY_FOR_HUMAN_REVIEW` and **ask the human** before running
  `/ralph-integrate`.
- Only run `/ralph-integrate` after the human approves; never auto-push; offer
  `/ralph-cleanup` afterward.

## Known limitations

- One story per run. The loop selects the first actionable open story (or `--task`).
- PRD status fields are not mutated (human-in-the-loop); selection is read-only.
- Worktrees are created under `<target-parent>/.ralph-worktrees/` (override with
  `RALPH_WORKTREE_DIR`) and are not auto-removed — use `ralph cleanup`.
- `RALPH_DRY_RUN=1` skips only the agent backends; check + preview/e2e still run.
- Preview/e2e correctness depends entirely on the target's own scripts; the
  harness only orchestrates them and feeds failures back to the builder.
