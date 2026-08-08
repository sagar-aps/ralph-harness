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
  `PROMPT_builder.md` / `PROMPT_reviewer.md`; config `review-config.sh`. The
  cron/orchestrator loop DRIVER is a third, independent role:
  `RALPH_CRON_DRIVER` (convention in `config.sh`, resolved by
  `ralph_resolve_cron_driver`), owned by the orchestrator per `ORCHESTRATOR.md`.
- Target scaffolding templates: `.agents/ralph/target-templates/` (used by
  `ralph init-target`). Operator commands: canonical set in `agent-commands/ralph/`,
  adapted per agent (claude/codex/copilot) by `ralph install-agent-commands`.
- Operator commands live in `bin/ralph`: `review`, `batch`, `preflight`, `status`,
  `integrate`, `cleanup`, `init-target`, `install-agent-commands`. Run metadata:
  `<target>/.ralph/last-run.env`; artifacts: `<target>/.ralph/runs/<run-id>/` (review)
  or `<target>/.agent-run/batch-<ts>/` (batch).
- Efficiency mode (opt-in, **governs nothing yet**): `.agents/ralph/efficiency.py` +
  `efficiency.sh` parse/validate the declarative profile (`efficiency.json`, gitignored;
  `efficiency.json.example` ships the policy). `--efficiency`/`RALPH_EFFICIENCY` only
  boot-validates — an invalid profile is rejected to inert/off, never fatal — and
  `ralph explain --complexity <tier>` reports which rung WOULD be chosen. Selection and
  dispatch are unchanged; wiring them is a later slice.

## Token economics (read before reasoning about cost or caching)

A batch here can burn hundreds of millions of tokens, and most intuitive assumptions
about prompt caching in this repo are wrong. **`.agents/ralph/references/TOKEN_ECONOMICS.md`**
is the single source of truth for provider cache behaviour, cached-token pricing, and
how to read usage out of each CLI. Read it before you claim a change will reduce spend,
edit a `PROMPT_*` template, or add a usage/cache column to a report.

The three things people get wrong most often:

- **Prompt caching works on the claude family and NOT on codex** (measured). Do not
  promise cache savings on a codex-backed run.
- **Deleting a token beats caching it** — cached tokens still bill at 10–20 %.
- **Prompt-template ordering is load-bearing.** Templates are ordered most-stable-first
  around a `DYNAMIC BOUNDARY`; one per-attempt token above it invalidates everything
  below. `tests/prompt-cache-prefix.mjs` enforces this.

## Quirks / Guardrails
**Add any common quirks guiderails here as needed**

- **Shell scripts must parse under Bash 3.2** (macOS `/bin/bash`; the loop runs via
  `#!/usr/bin/env bash`, which on a stock Mac is 3.2). `bash -n` on a dev box (bash 5.x)
  will NOT catch 3.2-only failures. Two rules that bite:
  1. **Bash 3.2 scans `$(...)` command-substitution heredoc bodies** and tracks quote/paren
     state through them. So inside `eval "$(python3 - … <<'PY' … PY)"` blocks, keep the body
     free of **apostrophes** (`repo's`, `can't`) and **unbalanced** `()`/`{}`/quotes — a lone
     `'` desyncs the parser and throws `syntax error near unexpected token '('` at a *later*
     line. (This was #21.)
  2. Avoid Bash 4+ features: `${v,,}`/`${v^^}`, `declare -A`, `mapfile`/`readarray`, `&>>`, `;;&`.
- **Verify 3.2 compatibility**: `npm test` includes `tests/shell-syntax.mjs` (runs `bash -n`
  on every shell script). Run it under a real 3.2 to be sure:
  `docker run --rm -v "$PWD:/w:ro" bash:3.2 sh -c 'for f in $(find /w -name "*.sh"); do bash -n "$f"; done'`
- **Builder no-op = never success (#22).** A builder that exits 0 with a confident "done"
  report but an EMPTY diff (vs the task's starting commit) is a no-op, not success — classic
  when a weak model narrates edits instead of making them. `batch-loop.sh` gates on this after
  each builder attempt: empty diff → skip check/reviewer, feed pointed feedback, retry; if no
  attempt ever produces a diff the task ends `NO_CHANGES` (a failure). Exit code alone never
  classifies a builder attempt as done.
- **Self-hosted builders (rlaude): always go through the wrapper.** `rlaude` neutralizes a
  stray `ANTHROPIC_API_KEY` (which takes precedence over `ANTHROPIC_AUTH_TOKEN` and would send
  `x-api-key` to the pod → 401, or misroute to real Anthropic) and pins every `ANTHROPIC_*_MODEL`
  to the one served model. Verify tools actually EXECUTE (not narrate) after any endpoint change:
  a raw `/v1/messages` call with a `tools` array must return `stop_reason":"tool_use"`.
