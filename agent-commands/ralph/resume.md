---
description: Resume the last Ralph batch run, skipping already-completed tasks
argument-hint: --repo <path> --plan <dir|file> [--builder <b>] [--reviewer <r>] [--auto-approve-builder]
---

Resume a Ralph **batch** that halted partway — typically because a backend became
unavailable (`REVIEWER_UNAVAILABLE` or `BUILDER_UNAVAILABLE`): the reviewer or
builder CLI returned errors (non-zero exit, or the reviewer produced no `VERDICT:`
line) on every retry. That is a tooling outage, not a task failure.

Before resuming:
1. Read `<target>/.ralph/last-run.env` and confirm `STATUS` is `REVIEWER_UNAVAILABLE`
   or `BUILDER_UNAVAILABLE` (or another non-complete state). The run's
   `final-report.md` explains which backend failed and includes a re-login hint.
2. **Fix the backend first** — re-authenticate / check quota for the failing CLI:
   - claude: run `claude` once to (re)login
   - codex: `codex login`
   - droid / opencode: re-run their auth/login flow
   Do not resume until the human confirms the backend works again.

Then resume with the SAME repo and plan:
```bash
ralph batch $ARGUMENTS --resume
```

What `--resume` does:
- reuses the SAME branch + worktree from the halted run (no new worktree),
- **skips every task that already PASSed** (they stay committed — not rebuilt),
- re-runs the task it halted on plus any remaining/failed tasks,
- then finishes normally (end-of-batch preview, final report).

Notes:
- Keep `--plan` pointing at the same plan, in the same order, so task numbers line up.
- Never bypass the failing backend by switching the reviewer to writable or skipping
  review — fix the auth/quota instead, then resume.
- When it finishes, summarize as usual and **ask the human before integrating**.
