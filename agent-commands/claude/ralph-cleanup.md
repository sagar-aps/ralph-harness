---
description: Clean up a Ralph run's worktree and preview for a target repo
argument-hint: --repo <path> [--run latest|<run-id>] [--delete-branch]
---

Clean up after a Ralph run: remove the run's git worktree and stop its preview if
a preview-down script/config exists.

Run:
```bash
ralph cleanup $ARGUMENTS
```

Notes for the human:
- By default this does NOT delete the run branch (so the work is preserved). Pass
  `--delete-branch` only if the human explicitly wants the branch removed.
- It will refuse to remove a worktree that still has uncommitted changes unless
  the human confirms / forces it.
- Report exactly what was removed/stopped and what was left in place.

Do not delete branches or force-remove dirty worktrees without explicit approval.
