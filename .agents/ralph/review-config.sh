# Optional config for the Ralph review loop (builder/reviewer).
# Sourced by review-loop.sh after agents.sh and config.sh.
# Everything here can also be set via CLI flags or environment variables.
#
# Roles are jobs in the workflow; backends are concrete agent commands.
# Any backend can be assigned to any role.
#
# --- Role -> backend assignments ---
# BUILDER=opencode-z
# REVIEWER=claude
#
# --- Backend command templates (override agents.sh defaults) ---
# A backend command either contains {prompt} (a file path is substituted, quoted)
# or reads the prompt from stdin.
# AGENT_OPENCODE_Z_CMD='opencode run "$(cat {prompt})"'
# AGENT_CLAUDE_CMD='claude -p --dangerously-skip-permissions "$(cat {prompt})"'
# AGENT_CODEX_WRITE_CMD='codex exec --sandbox workspace-write -'
# AGENT_CODEX_READONLY_CMD='codex exec --sandbox read-only -'
#
# Add a brand new backend with no code change — define AGENT_<NAME>_CMD where
# <NAME> is the backend name uppercased with dashes turned into underscores:
# AGENT_MY_AGENT_CMD='my-agent run {prompt}'   # backend name: my-agent
#
# --- Workflow ---
# MAX_ITERATIONS=5
# CHECK_CMD='./scripts/check.sh'
# VERDICT_REGEX='^VERDICT: (PASS|FAIL)'
# USE_WORKTREE=true
# ALLOW_DIRTY=false

# --- Managed mode (a Manager role gates this repo) ---
# Off by default. When on, the managed-builder addendum is appended to the builder
# prompt: the builder arbitrates via the Manager (PR/issue comments + blocked:manager
# label) instead of asking a human, takes only `now` + `spec:ready` issues, reports
# emergent findings as comments, and never approves/merges/pushes-main/deploys-prod.
# Install the Manager charter with `ralph init-target` and boot it with `/manager`.
# See docs/agent-operator.md.
# MANAGED_MODE=1
# MANAGED_ADDENDUM_FILE=".agents/ralph/PROMPT_managed_addendum.md"
#
# --- Prompt templates ---
# BUILDER_PROMPT=".agents/ralph/PROMPT_builder.md"
# REVIEWER_PROMPT=".agents/ralph/PROMPT_reviewer.md"
