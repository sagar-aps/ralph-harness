# Operating the Ralph harness (agent / human operator guide)

This guide is for whoever sits in the **pilot seat** driving the harness — a human
in a terminal, or a coding agent such as Claude Code, Codex, Cursor, etc. It is
intentionally generic; a Claude Code–specific section is at the end.

## Harness repo vs target repo

- **Harness repo** (this repo): the orchestrator. It owns the loop, the prompts,
  the backends, and the operator commands. It is *not* the project being built.
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

## One-time setup of a target

```bash
ralph init-target --repo /path/to/target            # generic
ralph init-target --repo /path/to/target --type nextjs-postgres   # + preview/e2e
```

This creates `.agents/tasks/`, `ralph.target.json`, `scripts/check.sh` (and the
preview scripts for `nextjs-postgres`), and adds `.ralph/` + `.agent-handoff.md`
to `.gitignore`. Then add a PRD JSON under `.agents/tasks/` and fill in the
scripts.

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

## Claude Code section

Install the operator slash-commands once:

```bash
ralph install-agent-commands     # installs into ~/.claude/commands/
```

This gives you:

- `/ralph-review <task> --repo <path> [--builder …] [--reviewer …] [--preview]`
- `/ralph-status --repo <path>`
- `/ralph-integrate --repo <path> [--run latest|<id>]`
- `/ralph-cleanup --repo <path> [--run latest|<id>] [--delete-branch]`

These commands teach Claude Code to *operate* the harness, not to reimplement it.
When acting as the operator, Claude Code should:

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
