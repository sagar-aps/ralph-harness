---
description: Show the status of the latest Ralph run for a target repo
argument-hint: --repo <path>
---

Report the status of the most recent Ralph run on the target repo.

Run:
```bash
ralph status $ARGUMENTS
```

Then summarize for the human in plain language:
- the run outcome (READY_FOR_HUMAN_REVIEW / FAILED_MAX_ITERATIONS / RUNNING)
- the branch and worktree
- the preview URL if one is available (offer to open it)
- where the artifacts live

If status is READY_FOR_HUMAN_REVIEW, remind the human that integration requires
their approval and show them the `ralph integrate` command — but do not run it
yourself until they say so.

Do not modify the target repo.
