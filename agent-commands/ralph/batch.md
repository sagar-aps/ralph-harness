---
description: Run many PRDs/tasks sequentially in ONE shared worktree via the Ralph batch loop
argument-hint: --repo <path> --plan <dir|file> [--builder <b>] [--reviewer <r>] [--auto-approve-builder] [--stop-on-fail] [--max-tasks <n>]
---

You are operating the **Ralph harness** as a pilot for an unattended, multi-task
run. Batch mode implements several PRDs/tasks **sequentially on one shared branch +
worktree**, so later tasks build on earlier ones. You drive Ralph — you do **not**
implement the tasks yourself.

Run the batch with the arguments the user gave: `$ARGUMENTS`

Steps:
1. Run the harness (do not implement tasks by hand):
   ```bash
   ralph batch $ARGUMENTS
   ```
   - `--plan` is required: a directory of `*.md` tasks (run in sorted order) or a
     single `.md` file split into tasks at its shallowest heading level.
   - For an unattended/overnight run the user will usually pass
     `--auto-approve-builder` (lets the BUILDER edit without permission prompts).
     The REVIEWER always stays read-only — never change that.
   - `--stop-on-fail` halts at the first failing task; otherwise the batch
     continues and marks failures.
   - If `--repo` or `--plan` is missing, ask the user before running.
2. The batch uses ONE worktree/branch `ralph/batch-<timestamp>` and runs, per task:
   builder → check → reviewer (read-only) → record result → commit on the branch.
   It never merges, pushes, or deletes anything.
3. When it finishes, read the final report at
   `<target>/.agent-run/batch-<timestamp>/final-report.md` (and `<target>/.ralph/last-run.env`)
   and summarize for the human:
   - outcome (READY_FOR_HUMAN_REVIEW / COMPLETED_WITH_FAILURES / STOPPED_ON_FAIL)
   - tasks attempted / completed / failed
   - per-task verdicts and files changed
   - any failures/blockers and where their logs are
   - the branch + worktree path
4. Then **ask the human** to review the branch. Only after they approve, integrate
   with `/ralph-integrate` (or `ralph integrate --repo <path>`), then offer
   `/ralph-cleanup`.

Never merge, push, delete branches/worktrees, or relax the reviewer to writable.
Never auto-approve the reviewer. Surface failures honestly rather than declaring
success because the builder said so.
