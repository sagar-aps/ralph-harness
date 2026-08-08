#!/usr/bin/env bash
# Default agent command templates (used by loop.sh and CLI).

# Keep external MCP servers and Codex app connectors out of builder/reviewer
# runs. Their write paths bypass the gh/git PATH guard used by the orchestrator.
CODEX_NO_MCP_ARGS="-c 'mcp_servers={}'"
CODEX_NO_APPS_ARGS="--disable apps"
CODEX_NO_CONNECTORS_ARGS="${CODEX_NO_MCP_ARGS} ${CODEX_NO_APPS_ARGS}"
AGENT_CODEX_CMD="codex exec ${CODEX_NO_CONNECTORS_ARGS} --yolo --skip-git-repo-check -"
AGENT_CODEX_INTERACTIVE_CMD="codex --yolo {prompt}"
AGENT_CLAUDE_CMD="env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL claude -p --dangerously-skip-permissions"
AGENT_CLAUDE_INTERACTIVE_CMD="claude --dangerously-skip-permissions {prompt}"
AGENT_DROID_CMD="droid exec --skip-permissions-unsafe -f {prompt}"
AGENT_DROID_INTERACTIVE_CMD="droid --skip-permissions-unsafe {prompt}"
# opencode reads the prompt as a POSITIONAL argv arg — it does NOT read stdin
# (unlike claude/codex), so the message must be interpolated on argv (ARG_MAX-bound).
# NOTE (#44): on the Z.AI Coding Plan, opencode's auto-selected default model
# (glm-5.2-highspeed) 429s with "plan does not include …" and the AI-SDK retry-loops
# on it (looks like a hang / exit 124). Pin a plan-included model with `-m`, e.g.
# `opencode run -m zai-coding-plan/glm-4.7 "$(cat {prompt})"` (see config.local.sh.example).
AGENT_OPENCODE_CMD='opencode run "$(cat {prompt})"'
AGENT_OPENCODE_INTERACTIVE_CMD="opencode --prompt {prompt}"
# Uncomment to use server mode (faster, avoids cold boot):
# AGENT_OPENCODE_CMD="opencode run --attach http://localhost:4096"
# AGENT_OPENCODE_INTERACTIVE_CMD="opencode --prompt {prompt} --attach http://localhost:4096"

# --- Extra backends for the builder/reviewer review loop ---
# Guarded assignments (only set if not already provided via env/config) so that
# templates containing `{prompt}` don't trip bash brace-matching in `${VAR:-...}`.
# "opencode-z" is OpenCode authenticated with the Z.AI Coding Plan. Same binary
# as opencode; named separately so a role can pin it explicitly.
# opencode-z: argv message (no stdin) + pin a plan-included model (#44).
[[ -n "${AGENT_OPENCODE_Z_CMD:-}" ]] || AGENT_OPENCODE_Z_CMD='opencode run "$(cat {prompt})"'
# Role selection is operator guidance, not harness enforcement: prefer different
# agents for builder and reviewer, and give the reviewer a read-only/sandbox flag
# whenever its CLI supports one. For other agents, define a backend using that
# agent's equivalent read-only flag; agents without one remain valid reviewers.
# Codex writable form (good default for a builder role):
#   codex exec -c 'mcp_servers={}' --disable apps --sandbox workspace-write -
[[ -n "${AGENT_CODEX_WRITE_CMD:-}" ]] || AGENT_CODEX_WRITE_CMD="codex exec ${CODEX_NO_CONNECTORS_ARGS} --sandbox workspace-write -"
# Codex read-only form (the codex-readonly backend, preferred for a reviewer):
#   codex exec -c 'mcp_servers={}' --disable apps --sandbox read-only -
[[ -n "${AGENT_CODEX_READONLY_CMD:-}" ]] || AGENT_CODEX_READONLY_CMD="codex exec ${CODEX_NO_CONNECTORS_ARGS} --sandbox read-only -"

DEFAULT_AGENT="codex"

# Print the values selected by --model VALUE, --model=VALUE, or -m VALUE in a
# command template, one per line. Python shlex keeps quoted wrapper arguments
# intact without evaluating any part of the command.
ralph_command_model_values() {  # <command>
  python3 - "$1" <<'PY'
import shlex
import sys

try:
    words = shlex.split(sys.argv[1])
except ValueError as exc:
    print(f"ralph: cannot inspect backend model selectors: {exc}", file=sys.stderr)
    raise SystemExit(1)

i = 0
while i < len(words):
    word = words[i]
    if word in ("--model", "-m"):
        if i + 1 >= len(words):
            print(f"ralph: backend model selector {word} has no value", file=sys.stderr)
            raise SystemExit(1)
        print(words[i + 1])
        i += 2
        continue
    if word.startswith("--model="):
        value = word.split("=", 1)[1]
        if not value:
            print("ralph: backend model selector --model= has no value", file=sys.stderr)
            raise SystemExit(1)
        print(value)
    i += 1
PY
}

ralph_validate_model_selectors() {  # <command label> <command>
  local label="$1" values count first rest
  values="$(ralph_command_model_values "$2")" || return 1
  [[ -n "$values" ]] || return 0
  count="$(printf '%s\n' "$values" | wc -l | tr -d ' ')"
  [[ "$count" -le 1 ]] && return 0
  first="${values%%$'\n'*}"
  rest="${values#*$'\n'}"
  if [[ "$rest" == "$first" && "$rest" != *$'\n'* ]]; then
    echo "ralph: duplicate model selectors in $label both select '$first'; keep exactly one model selector" >&2
  else
    echo "ralph: conflicting model selectors in $label select '$first' and '$(printf '%s' "$rest" | tr '\n' ',')'; keep exactly one authoritative model selector" >&2
  fi
  return 1
}

# Harden Codex exec commands at resolution, including operator overrides, so an
# older local template cannot restore MCP/app connector write paths.
ralph_codex_disable_connectors() {  # <codex command>
  local cmd="$1"
  [[ "$cmd" == codex\ exec\ * ]] || { printf '%s' "$cmd"; return; }
  [[ "$cmd" == *"mcp_servers={}"* ]] || cmd="${cmd/codex exec /codex exec ${CODEX_NO_MCP_ARGS} }"
  [[ "$cmd" == *"--disable apps"* ]] || cmd="${cmd/codex exec /codex exec ${CODEX_NO_APPS_ARGS} }"
  printf '%s' "$cmd"
}

# Resolve a backend NAME (e.g. "claude", "opencode-z", "codex-readonly") to its
# command template. Unknown names fall back to AGENT_<UPPER_WITH_UNDERSCORES>_CMD
# so new backends only need a variable defined here or in config.sh — no code
# change required. This keeps ROLE (builder/reviewer) separate from BACKEND.
resolve_backend_cmd() {
  # Note: do NOT inline `${VAR:-default}` fallbacks here — the templates contain
  # `{prompt}` whose `}` would prematurely close the expansion. All AGENT_*_CMD
  # vars are defined above (or in config.sh), so a plain expansion is correct.
  local name="$1" cmd
  case "$name" in
    claude)          cmd="${AGENT_CLAUDE_CMD}" ;;
    droid)           cmd="${AGENT_DROID_CMD}" ;;
    opencode)        cmd="${AGENT_OPENCODE_CMD}" ;;
    opencode-z)      cmd="${AGENT_OPENCODE_Z_CMD}" ;;
    codex|"")        cmd="$(ralph_codex_disable_connectors "${AGENT_CODEX_CMD}")" ;;
    codex-write)     cmd="$(ralph_codex_disable_connectors "${AGENT_CODEX_WRITE_CMD}")" ;;
    codex-readonly)  cmd="$(ralph_codex_disable_connectors "${AGENT_CODEX_READONLY_CMD}")" ;;
    cxb)             cmd="$(ralph_codex_disable_connectors "${AGENT_CXB_CMD:-}")" ;;
    cxr)             cmd="$(ralph_codex_disable_connectors "${AGENT_CXR_CMD:-}")" ;;
    *)
      # Generic fallback: foo-bar -> $AGENT_FOO_BAR_CMD
      local var
      var="AGENT_$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')_CMD"
      cmd="${!var:-}"
      ;;
  esac
  ralph_validate_model_selectors "backend '$name'" "$cmd" || return 1
  printf '%s\n' "$cmd"
}

# Detect an exhausted provider usage window in a captured backend log. This is
# deliberately narrower than a generic HTTP 429: the default requires both an
# explicit usage-limit exhaustion and a reset time. Operators may replace the
# ERE with RALPH_QUOTA_REGEX for providers that use different terminal wording.
# On a match, machine-friendly RALPH_QUOTA_* globals are set and persisted when
# RALPH_QUOTA_ARTIFACT names a run artifact. Credential-pool identity is explicit
# because two backend names can share one provider account. Returns 0 on a match.
ralph_env_assignment() {  # <name> <value> -- emit a safely sourceable assignment
  printf '%s=' "$1"
  printf '%q' "$2"
  printf '\n'
}

ralph_quota_reset_elapsed() {  # <reset timestamp>
  [[ -n "$1" ]] || return 1
  python3 - "$1" <<'PY' >/dev/null 2>&1
import datetime
import sys

raw = sys.argv[1].strip().replace("Z", "+00:00")
try:
    reset = datetime.datetime.fromisoformat(raw)
except ValueError:
    raise SystemExit(1)
if reset.tzinfo is None:
    reset = reset.replace(tzinfo=datetime.timezone.utc)
raise SystemExit(0 if datetime.datetime.now(datetime.timezone.utc) >= reset else 1)
PY
}

ralph_quota_forget_pool() {  # <credential_pool>
  local wanted="$1" line pool kept=""
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    pool="${line%%|*}"
    [[ "$pool" == "$wanted" ]] && continue
    kept="${kept}${kept:+
}${line}"
  done <<EOF
${RALPH_QUOTA_OPEN_CIRCUITS:-}
EOF
  RALPH_QUOTA_OPEN_CIRCUITS="$kept"
  export RALPH_QUOTA_OPEN_CIRCUITS
}

ralph_quota_pool_is_exhausted() {  # <credential_pool>
  local wanted="$1" line pool reset
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    pool="${line%%|*}"
    reset="${line#*|}"
    [[ "$pool" == "$wanted" ]] || continue
    if ralph_quota_reset_elapsed "$reset"; then
      ralph_quota_forget_pool "$wanted"
      return 1
    fi
    return 0
  done <<EOF
${RALPH_QUOTA_OPEN_CIRCUITS:-}
EOF
  return 1
}

ralph_detect_quota_exhaustion() {  # <logfile> [provider] [credential_pool]
  local logfile="$1" provider="${2:-unknown}" pool="${3:-${2:-unknown}}" regex line reset scope observed record
  regex="${RALPH_QUOTA_REGEX:-}"
  [[ -n "$regex" ]] || regex='usage[[:space:]]+limit[[:space:]]+reached.*reset[[:space:]]+at[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}'
  [[ -f "$logfile" ]] || return 1
  line="$(grep -Eim1 "$regex" "$logfile" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 1

  reset="$(printf '%s\n' "$line" | sed -E 's/.*[Rr]eset[[:space:]]+at[[:space:]]+([^]]+).*/\1/' | sed -E 's/[[:space:]]+$//')"
  [[ "$reset" != "$line" ]] || reset=""
  scope="$(printf '%s\n' "$line" | sed -E 's/.*[Uu]sage[[:space:]]+limit[[:space:]]+reached([[:space:]]+for)?[[:space:]]*([^.]*)\..*/\2/' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [[ "$scope" != "$line" ]] || scope=""
  observed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  RALPH_QUOTA_PROVIDER="$provider"
  RALPH_QUOTA_CREDENTIAL_POOL="$pool"
  RALPH_QUOTA_SCOPE="$scope"
  RALPH_QUOTA_OBSERVED_AT="$observed"
  RALPH_QUOTA_RESET_AT="$reset"
  record="${pool}|${reset}"
  ralph_quota_forget_pool "$pool"
  RALPH_QUOTA_OPEN_CIRCUITS="${RALPH_QUOTA_OPEN_CIRCUITS}${RALPH_QUOTA_OPEN_CIRCUITS:+
}${record}"
  export RALPH_QUOTA_PROVIDER RALPH_QUOTA_CREDENTIAL_POOL RALPH_QUOTA_SCOPE \
    RALPH_QUOTA_OBSERVED_AT RALPH_QUOTA_RESET_AT RALPH_QUOTA_OPEN_CIRCUITS
  if [[ -n "${RALPH_QUOTA_ARTIFACT:-}" ]]; then
    {
      ralph_env_assignment STATUS PROVIDER_QUOTA_EXHAUSTED
      ralph_env_assignment PROVIDER "$RALPH_QUOTA_PROVIDER"
      ralph_env_assignment CREDENTIAL_POOL "$RALPH_QUOTA_CREDENTIAL_POOL"
      ralph_env_assignment SCOPE "$RALPH_QUOTA_SCOPE"
      ralph_env_assignment OBSERVED_AT "$RALPH_QUOTA_OBSERVED_AT"
      ralph_env_assignment RESET_AT "$RALPH_QUOTA_RESET_AT"
    } > "$RALPH_QUOTA_ARTIFACT"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Normalized role agent selection (issue #4): {provider, model, effort} per role.
#
# Opt-in. When a role spec (BUILDER_PROVIDER/MODEL/EFFORT, REVIEWER_*) or a preset
# (RALPH_PROFILE) is present, compose two synthetic backends — ralph-build /
# ralph-review — via a per-provider adapter, and point BUILDER/REVIEWER at them
# (the generic `foo-bar -> AGENT_FOO_BAR_CMD` fallback above resolves them). When
# NO spec is present this is a no-op: the legacy `--builder <name>` path is fully
# preserved. Precedence is `:=`-based — an explicit --builder/--reviewer or env
# BUILDER/REVIEWER still wins, a set knob beats a preset default.
#
# Effort scale: low|medium|high. codex maps it directly; claude effort is deferred
# (needs MAX_THINKING_TOKENS, which can't ride in the command string); zai,
# opencode, and droid ignore it. Reviewer read-only is preserved: codex uses
# --sandbox read-only, and
# every builder's permission-skip flag is stripped by strip_autoapprove downstream.
ralph_effort_flag() {  # <provider> <effort>
  [[ -n "$2" ]] || return 0
  case "$1" in
    codex) printf ' -c model_reasoning_effort=%s' "$2" ;;
    *)     : ;;
  esac
}

ralph_provider_cmd() {  # <mode: build|review> <provider> <model> <effort>
  local mode="$1" provider="$2" model="$3" effort="$4" e mflag cmd base values
  e="$(ralph_effort_flag "$provider" "$effort")"
  case "$provider" in
    codex)
      mflag=""; [[ -n "$model" ]] && mflag=" -m $model"
      if [[ "$mode" == "review" ]]; then
        cmd="$(printf 'codex exec %s --sandbox read-only%s%s -' "$CODEX_NO_CONNECTORS_ARGS" "$mflag" "$e")"
      else
        cmd="$(printf 'codex exec %s --yolo --skip-git-repo-check%s%s -' "$CODEX_NO_CONNECTORS_ARGS" "$mflag" "$e")"
      fi ;;
    claude)
      mflag=""; [[ -n "$model" ]] && mflag=" --model $model"
      cmd="$(printf 'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL claude%s -p --dangerously-skip-permissions' "$mflag")" ;;
    zai|zlaude)
      mflag=""; [[ -n "$model" ]] && mflag=" --model $model"
      # Keep these as runtime environment references: resolved commands are logged,
      # so expanding the auth token while composing would leak it into run artifacts.
      cmd="$(printf 'env -u ANTHROPIC_API_KEY -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_BASE_URL="${RALPH_ZAI_BASE_URL:-https://api.z.ai/api/anthropic}" ANTHROPIC_AUTH_TOKEN="${RALPH_ZAI_AUTH_TOKEN:-}" claude -p --dangerously-skip-permissions%s' "$mflag")" ;;
    opencode)
      mflag=""; [[ -n "$model" ]] && mflag=" --model $model"
      # opencode reads the message from argv, not stdin (#44) — keep {prompt}.
      cmd="$(printf 'opencode run%s "$(cat {prompt})"' "$mflag")" ;;
    droid)
      cmd='droid exec --skip-permissions-unsafe -f {prompt}' ;;
    *)
      # A custom provider is a wrapper backend. Reconcile its default model with
      # Ralph's explicit role model before composing the final command.
      base="$(resolve_backend_cmd "$provider")" || return 1
      cmd="$base"
      if [[ -n "$model" ]]; then
        values="$(ralph_command_model_values "$base")" || return 1
        if [[ -z "$values" ]]; then
          cmd="$base --model $model"
        elif [[ "$values" != "$model" ]]; then
          echo "ralph: model selection conflict for $mode provider '$provider': wrapper selects '$values' but Ralph explicitly requested '$model'; remove the wrapper model selector or omit Ralph's model setting" >&2
          return 1
        fi
      fi ;;
  esac
  ralph_validate_model_selectors "$mode provider '$provider' command" "$cmd" || return 1
  printf '%s' "$cmd"
}

# A preset fills any UNSET knob (an explicit spec still wins via :=).
ralph_apply_profile() {  # <profile>
  case "$1" in
    cheap)    : "${BUILDER_PROVIDER:=codex}" "${BUILDER_EFFORT:=low}"    "${REVIEWER_PROVIDER:=codex}" "${REVIEWER_EFFORT:=low}" ;;
    balanced) : "${BUILDER_PROVIDER:=codex}" "${BUILDER_EFFORT:=medium}" "${REVIEWER_PROVIDER:=codex}" "${REVIEWER_EFFORT:=low}" ;;
    max)      : "${BUILDER_PROVIDER:=codex}" "${BUILDER_EFFORT:=high}"   "${REVIEWER_PROVIDER:=codex}" "${REVIEWER_EFFORT:=medium}" ;;
    *)        echo "ralph: unknown RALPH_PROFILE '$1' (expected cheap|balanced|max)" >&2 ;;
  esac
}

ralph_resolve_role_agents() {
  local build_cmd review_cmd role_name role_var
  # `--builder zai --builder-model ...` is the convenient Z.AI spelling from the
  # operator docs. Treat zai/zlaude as normalized providers when there is no
  # same-named explicit AGENT_*_CMD override; an override keeps the legacy custom
  # backend path and therefore remains fully backward-compatible.
  if [[ -z "${BUILDER_PROVIDER:-}" ]]; then
    case "${BUILDER:-}" in
      zai|zlaude)
        role_name="$BUILDER"
        role_var="AGENT_$(printf '%s' "$role_name" | tr 'a-z-' 'A-Z_')_CMD"
        if [[ -z "${!role_var:-}" ]]; then BUILDER_PROVIDER="$role_name"; BUILDER=""; fi
        ;;
    esac
  fi
  if [[ -z "${REVIEWER_PROVIDER:-}" ]]; then
    case "${REVIEWER:-}" in
      zai|zlaude)
        role_name="$REVIEWER"
        role_var="AGENT_$(printf '%s' "$role_name" | tr 'a-z-' 'A-Z_')_CMD"
        if [[ -z "${!role_var:-}" ]]; then REVIEWER_PROVIDER="$role_name"; REVIEWER=""; fi
        ;;
    esac
  fi
  # Act only if the operator asked for normalized selection.
  [[ -n "${RALPH_PROFILE:-}${BUILDER_PROVIDER:-}${REVIEWER_PROVIDER:-}${BUILDER_MODEL:-}${REVIEWER_MODEL:-}${BUILDER_EFFORT:-}${REVIEWER_EFFORT:-}" ]] || return 0
  [[ -n "${RALPH_PROFILE:-}" ]] && ralph_apply_profile "$RALPH_PROFILE"
  : "${BUILDER_PROVIDER:=codex}" "${REVIEWER_PROVIDER:=codex}"
  build_cmd="$(ralph_provider_cmd build "$BUILDER_PROVIDER" "${BUILDER_MODEL:-}" "${BUILDER_EFFORT:-}")" || return 1
  review_cmd="$(ralph_provider_cmd review "$REVIEWER_PROVIDER" "${REVIEWER_MODEL:-}" "${REVIEWER_EFFORT:-}")" || return 1
  AGENT_RALPH_BUILD_CMD="$build_cmd"
  AGENT_RALPH_REVIEW_CMD="$review_cmd"
  export AGENT_RALPH_BUILD_CMD AGENT_RALPH_REVIEW_CMD
  # Point the roles at the synthetic backends unless already pinned (flag/env wins).
  : "${BUILDER:=ralph-build}" "${REVIEWER:=ralph-review}"
}
# NOTE: the loops (batch-loop.sh / review-loop.sh) call ralph_resolve_role_agents
# AFTER sourcing config.local.sh, so the operator's specs are in scope. Do NOT call
# it here at source time — agents.sh is sourced before config.local.sh.

# ---------------------------------------------------------------------------
# Cron / orchestrator loop DRIVER selection (issue #52).
#
# The driver is the agent that wakes on the recurring cadence, reads ORCHESTRATOR.md
# and runs one loop pass. It is a THIRD role, independent of builder/reviewer: this
# resolver never reads or writes BUILDER/REVIEWER, and role selection never reads
# RALPH_CRON_DRIVER. The convention itself (and its default) is documented in
# config.sh; a driver script/cron entry calls ralph_resolve_cron_driver to turn it
# into a command.
#
# Accepted spellings, in precedence order:
#   1. RALPH_CRON_DRIVER_PROVIDER (+ _MODEL / _EFFORT) — a normalized spec composed
#      by the same ralph_provider_cmd adapter the roles use, exposed as the
#      synthetic backend name "ralph-cron" (AGENT_RALPH_CRON_CMD).
#   2. RALPH_CRON_DRIVER — a backend NAME resolved by resolve_backend_cmd.
#   3. Neither set — RALPH_CRON_DRIVER_DEFAULT (config.sh), which itself defaults to
#      $DEFAULT_AGENT. No vendor is hardcoded: repoint either variable and every
#      unset caller follows.
#
# The driver is composed in `build` (writable) mode — unlike the reviewer it has to
# act: dispatch the harness, deploy dev, file PRs.
#
# The printed command is self-contained, so `cmd="$(ralph_resolve_cron_driver)"` is a
# valid call. It ALSO sets RALPH_CRON_DRIVER_BACKEND / RALPH_CRON_DRIVER_CMD (and
# AGENT_RALPH_CRON_CMD for a normalized spec) in the calling shell — a caller that
# wants those must invoke it directly (redirect its stdout) rather than inside
# `$(...)`, which would discard them with the subshell.
ralph_resolve_cron_driver() {  # -> runnable command template on stdout
  local provider model effort name cmd var
  provider="${RALPH_CRON_DRIVER_PROVIDER:-}"
  model="${RALPH_CRON_DRIVER_MODEL:-}"
  effort="${RALPH_CRON_DRIVER_EFFORT:-}"
  name="${RALPH_CRON_DRIVER:-}"
  if [[ -n "$provider$model$effort" ]]; then
    # A model/effort with no provider still needs one: the name spelling (or the
    # documented default) names it.
    [[ -n "$provider" ]] || provider="${name:-${RALPH_CRON_DRIVER_DEFAULT:-${DEFAULT_AGENT:-codex}}}"
    cmd="$(ralph_provider_cmd build "$provider" "$model" "$effort")" || return 1
    AGENT_RALPH_CRON_CMD="$cmd"
    export AGENT_RALPH_CRON_CMD
    name="ralph-cron"
  fi
  [[ -n "$name" ]] || name="${RALPH_CRON_DRIVER_DEFAULT:-${DEFAULT_AGENT:-codex}}"
  cmd="$(resolve_backend_cmd "$name")" || return 1
  if [[ -z "$cmd" ]]; then
    var="AGENT_$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')_CMD"
    echo "ralph: cron driver '$name' has no command; define $var (see .agents/ralph/config.local.sh.example)" >&2
    return 1
  fi
  RALPH_CRON_DRIVER_BACKEND="$name"
  RALPH_CRON_DRIVER_CMD="$cmd"
  export RALPH_CRON_DRIVER_BACKEND RALPH_CRON_DRIVER_CMD
  printf '%s\n' "$cmd"
}
