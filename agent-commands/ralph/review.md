---
description: Run the Ralph builder/reviewer loop on a target repo and summarize the result
argument-hint: <task-index|task-id> --repo <path> [--builder <b>] [--reviewer <r>] [--preview]
---

You are operating the **Ralph harness** as a pilot. Ralph is the orchestrator; the
target repo is the project being changed. You drive Ralph — you do **not**
implement the PRD yourself.

`ralph review` handles ONE task. For several tasks in one unattended run (one shared
worktree, sequential), use `/ralph-batch` instead.

Run the review loop with the arguments the user gave: `$ARGUMENTS`

Steps:
1. Run the harness (do not implement the task by hand):
   ```bash
   ralph review $ARGUMENTS
   ```
   If `--repo` is missing, ask the user for the target repo path first.
2. Stream/observe the output. The loop runs builder → check → (preview → e2e) →
   reviewer, repeating on failure up to max iterations.
3. When it finishes, read `<target>/.ralph/last-run.env` and the run's
   `final_status.md` and summarize for the human:
   - outcome (READY_FOR_HUMAN_REVIEW or FAILED_MAX_ITERATIONS)
   - branch, worktree, artifacts dir
   - preview URL if present
   - the most important reviewer findings
4. If READY_FOR_HUMAN_REVIEW: tell the human how to inspect (diff + preview URL)
   and **ask for approval before integrating**. Do not run `ralph integrate`
   until the human approves.
5. If FAILED_MAX_ITERATIONS: summarize why it failed and suggest next steps
   (e.g. raise `--max-iterations`, fix the PRD, or run again). Do not integrate.

Never merge to main. Never bypass the harness to implement the task directly
unless the user explicitly asks you to.
