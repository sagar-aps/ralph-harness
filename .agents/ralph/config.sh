# Optional Ralph config overrides.
# All paths are relative to repo root unless absolute.
# Uncomment and edit as needed.

# PRD_PATH=".agents/tasks/prd.json"
# PROGRESS_PATH=".ralph/progress.md"
# GUARDRAILS_PATH=".ralph/guardrails.md"
# ERRORS_LOG_PATH=".ralph/errors.log"
# ACTIVITY_LOG_PATH=".ralph/activity.log"
# TMP_DIR=".ralph/.tmp"
# RUNS_DIR=".ralph/runs"
# GUARDRAILS_REF=".agents/ralph/references/GUARDRAILS.md"
# CONTEXT_REF=".agents/ralph/references/CONTEXT_ENGINEERING.md"
# ACTIVITY_CMD=".agents/ralph/log-activity.sh"
# AGENT_CMD defaults are defined in agents.sh. Override here if needed.
# AGENT_CMD="codex exec --yolo --skip-git-repo-check -"
# PRD_AGENT_CMD defaults are defined in agents.sh (interactive).
# PRD_AGENT_CMD="codex --yolo --skip-git-repo-check {prompt}"
# AGENT_CMD="claude -p --dangerously-skip-permissions"
# AGENT_CMD="droid exec --skip-permissions-unsafe -f {prompt}"
# AGENTS_PATH="AGENTS.md"
# PROMPT_BUILD=".agents/ralph/PROMPT_build.md"
# NO_COMMIT=false
# MAX_ITERATIONS=25
# STALE_SECONDS=0

# ---------------------------------------------------------------------------
# RALPH_CRON_DRIVER — which agent DRIVES the recurring orchestrator/cron loop
# ---------------------------------------------------------------------------
# The DRIVER is the CLI/model that wakes on the cadence, reads ORCHESTRATOR.md and
# runs one loop pass. It is a THIRD role: it does NOT change builder/reviewer
# selection (BUILDER/REVIEWER and the normalized BUILDER_*/REVIEWER_* knobs), and
# they do not change it. A driver script or cron entry resolves it with
# `ralph_resolve_cron_driver` (agents.sh), which yields a command the same way the
# roles get theirs.
#
# Two spellings, both resolved by the shared machinery:
#   RALPH_CRON_DRIVER="<backend name>"      # e.g. codex, zlaude, opencode-z, or any
#                                           # AGENT_<NAME>_CMD you define
#   RALPH_CRON_DRIVER_PROVIDER="<provider>" # normalized {provider, model, effort},
#   RALPH_CRON_DRIVER_MODEL="<model>"       # composed like a role spec (#4)
#   RALPH_CRON_DRIVER_EFFORT="low|medium|high"
#
# DEFAULT WHEN UNSET (applied by ralph_resolve_cron_driver, so nothing here freezes it
# — an override in config.local.sh, sourced LAST, still wins):
#
#     RALPH_CRON_DRIVER_DEFAULT  ->  $DEFAULT_AGENT (agents.sh)  ->  codex
#
# i.e. by default the loop is driven by "whatever this install already drives agents
# with", the harness's one operator-owned default. No vendor is hardcoded as the sole
# driver: repoint DEFAULT_AGENT and every unset caller follows, or pin the driver
# default alone here / in config.local.sh:
# RALPH_CRON_DRIVER_DEFAULT="opencode-z"
#
# HOW TO CHOOSE: a loop pass is MECHANICAL mid-tier throughput (read labels, dispatch
# the harness, run the Manager's acceptance verbatim, file a PR) — the expensive
# judgment lives a tier up. So the right value is the CHEAPEST COMPETENT driver: the
# cheapest free-tier/plan model that can still finish a pass end to end, which is
# usually NOT the model of the session that configured it. Making and revising that
# call is the orchestrator's remit — see ORCHESTRATOR.md.
# ---------------------------------------------------------------------------
# Efficiency mode (opt-in) — RALPH_EFFICIENCY / RALPH_EFFICIENCY_PROFILE
# ---------------------------------------------------------------------------
# RALPH_EFFICIENCY=1 (or --efficiency) makes review/batch boot-validate the
# declarative efficiency profile and then right-size each ticket from it: a ticket
# carrying a complexity:<tier> label/PRD field gets the profile rung's builder and
# reviewer instead of the ones resolved here. DEFAULT OFF: without the opt-in,
# dispatch is exactly the --builder/--reviewer path below, unchanged. A ticket with
# no tier, or an invalid/missing profile, is inert (loud warning, normal dispatch);
# no eligible rung is a bounded clean pause (EFFICIENCY_PAUSED). It never crashes.
#
# The profile is operator policy and is gitignored (like config.local.sh). Copy
# efficiency.json.example to efficiency.json to configure one, or point elsewhere:
# RALPH_EFFICIENCY_PROFILE=".agents/ralph/efficiency.json"
#
# Read the policy back with: ralph explain --complexity <trivial|small|medium|large>

# Per-provider pricing table (USD per million tokens) used by `ralph report`.
# Defaults to pricing.json shipped next to this file. Override with a path to
# your own pricing file (same JSON schema) — e.g. in config.local.sh.
# RALPH_PRICING_FILE=".agents/ralph/pricing.json"
