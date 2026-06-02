# AGENTS

Keep this file short. It is always loaded into context.

## Build & test
- No build step.
- Tests (dry-run): `npm test`
- Fast real agent check: `npm run test:ping`
- Full real loop: `npm run test:real`

## CLI shape
- CLI entry: `bin/ralph`
- Templates: `.agents/ralph/` (copied to repos on install)
- State/logs: `.ralph/` (local only)
- Skills: `skills/`
- Tests: `tests/`
- Docs/examples: `README.md`, `examples/`, `docs/agent-operator.md`

## Review loop + operator (target-repo orchestration)
- Preflight (repo contract): `.agents/ralph/preflight.sh` — runs configured
  install/check/test/e2e from `ralph.target.json` before any worktree/agent;
  blocks build/review/batch on failure (exit 3, STATUS=PREFLIGHT_FAILED). Also a
  standalone `ralph preflight`; bypass with `--no-preflight`.
- Single-agent build loop: `.agents/ralph/loop.sh` (unchanged, runs in-place).
- Adversarial loop: `.agents/ralph/review-loop.sh` — builder/reviewer on a SEPARATE
  target repo via worktree, optional preview/e2e lifecycle, never merges.
- Batch loop: `.agents/ralph/batch-loop.sh` — many tasks sequentially in ONE shared
  worktree; per-task builder/reviewer retry loop (`--max-iterations`); prompts
  `PROMPT_batch_builder.md` / `PROMPT_batch_reviewer.md`. Artifacts in
  `<target>/.agent-run/batch-<ts>/`; `--auto-approve-builder` affects only the
  builder; reviewer always read-only. Never merges/pushes/deletes. Harness-detected
  agent ERROR (backend non-zero exit, or reviewer with no `VERDICT:`) is retried
  (`RALPH_AGENT_RETRIES`) then halts the batch with `REVIEWER_UNAVAILABLE` /
  `BUILDER_UNAVAILABLE` (exit 4); `--resume` continues, skipping already-PASSed tasks.
- Backends/roles: `.agents/ralph/agents.sh` (`resolve_backend_cmd`); prompts
  `PROMPT_builder.md` / `PROMPT_reviewer.md`; config `review-config.sh`.
- Target scaffolding templates: `.agents/ralph/target-templates/` (used by
  `ralph init-target`). Operator commands: canonical set in `agent-commands/ralph/`,
  adapted per agent (claude/codex/copilot) by `ralph install-agent-commands`.
- Operator commands live in `bin/ralph`: `review`, `batch`, `preflight`, `status`,
  `integrate`, `cleanup`, `init-target`, `install-agent-commands`. Run metadata:
  `<target>/.ralph/last-run.env`; artifacts: `<target>/.ralph/runs/<run-id>/` (review)
  or `<target>/.agent-run/batch-<ts>/` (batch).

## Quirks / Guardrails
**Add any common quirks guiderails here as needed**
