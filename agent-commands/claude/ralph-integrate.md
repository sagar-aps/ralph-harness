---
description: Integrate an approved Ralph run branch into the target's current branch
argument-hint: --repo <path> [--run latest|<run-id>]
---

Integrate a **human-approved** Ralph run. Only do this after the human has
explicitly approved the work (inspected the diff and, if applicable, the preview).

1. Confirm approval. If the human has not clearly approved this specific run,
   stop and ask. Do not assume.
2. Run:
   ```bash
   ralph integrate $ARGUMENTS
   ```
   This refuses unless the run is READY_FOR_HUMAN_REVIEW (override needs `--force`),
   refuses if the target repo is dirty, merges the run branch into the current
   target branch, and re-runs the target check command after merging.
   On success it then **automatically cleans up** that run: stops the preview and
   removes the worktree, **keeping the branch**. If the post-merge check fails, it
   skips cleanup and leaves the worktree/preview in place for debugging.
3. Report the merge result, the post-merge check result, and what cleanup did
   (preview stopped / worktree removed / branch kept).
4. The harness never pushes. Tell the human they can push when ready
   (e.g. `git -C <repo> push`).

Flags to know:
- `--keep-worktree` (or `--skip-cleanup`): integrate but do NOT auto-clean up.
- `--delete-branch`: also delete the run branch (only if the human asks).

Never auto-push. Never delete branches unless the human explicitly asks.
