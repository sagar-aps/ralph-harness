#!/usr/bin/env bash
# Default agent command templates (used by loop.sh and CLI).

AGENT_CODEX_CMD="codex exec --yolo --skip-git-repo-check -"
AGENT_CODEX_INTERACTIVE_CMD="codex --yolo {prompt}"
AGENT_CLAUDE_CMD="env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL claude -p --dangerously-skip-permissions"
AGENT_CLAUDE_INTERACTIVE_CMD="claude --dangerously-skip-permissions {prompt}"
AGENT_DROID_CMD="droid exec --skip-permissions-unsafe -f {prompt}"
AGENT_DROID_INTERACTIVE_CMD="droid --skip-permissions-unsafe {prompt}"
AGENT_OPENCODE_CMD="opencode run"
AGENT_OPENCODE_INTERACTIVE_CMD="opencode --prompt {prompt}"
# Uncomment to use server mode (faster, avoids cold boot):
# AGENT_OPENCODE_CMD="opencode run --attach http://localhost:4096"
# AGENT_OPENCODE_INTERACTIVE_CMD="opencode --prompt {prompt} --attach http://localhost:4096"

# --- Extra backends for the builder/reviewer review loop ---
# Guarded assignments (only set if not already provided via env/config) so that
# templates containing `{prompt}` don't trip bash brace-matching in `${VAR:-...}`.
# "opencode-z" is OpenCode authenticated with the Z.AI Coding Plan. Same binary
# as opencode; named separately so a role can pin it explicitly.
[[ -n "${AGENT_OPENCODE_Z_CMD:-}" ]] || AGENT_OPENCODE_Z_CMD='opencode run'
# Role selection is operator guidance, not harness enforcement: prefer different
# agents for builder and reviewer, and give the reviewer a read-only/sandbox flag
# whenever its CLI supports one. For other agents, define a backend using that
# agent's equivalent read-only flag; agents without one remain valid reviewers.
# Codex writable form (good default for a builder role):
#   codex exec --sandbox workspace-write -
[[ -n "${AGENT_CODEX_WRITE_CMD:-}" ]] || AGENT_CODEX_WRITE_CMD='codex exec --sandbox workspace-write -'
# Codex read-only form (the codex-readonly backend, preferred for a reviewer):
#   codex exec --sandbox read-only -
[[ -n "${AGENT_CODEX_READONLY_CMD:-}" ]] || AGENT_CODEX_READONLY_CMD='codex exec --sandbox read-only -'

DEFAULT_AGENT="codex"

# Resolve a backend NAME (e.g. "claude", "opencode-z", "codex-readonly") to its
# command template. Unknown names fall back to AGENT_<UPPER_WITH_UNDERSCORES>_CMD
# so new backends only need a variable defined here or in config.sh — no code
# change required. This keeps ROLE (builder/reviewer) separate from BACKEND.
resolve_backend_cmd() {
  # Note: do NOT inline `${VAR:-default}` fallbacks here — the templates contain
  # `{prompt}` whose `}` would prematurely close the expansion. All AGENT_*_CMD
  # vars are defined above (or in config.sh), so a plain expansion is correct.
  local name="$1"
  case "$name" in
    claude)          echo "${AGENT_CLAUDE_CMD}" ;;
    droid)           echo "${AGENT_DROID_CMD}" ;;
    opencode)        echo "${AGENT_OPENCODE_CMD}" ;;
    opencode-z)      echo "${AGENT_OPENCODE_Z_CMD}" ;;
    codex|"")        echo "${AGENT_CODEX_CMD}" ;;
    codex-write)     echo "${AGENT_CODEX_WRITE_CMD}" ;;
    codex-readonly)  echo "${AGENT_CODEX_READONLY_CMD}" ;;
    *)
      # Generic fallback: foo-bar -> $AGENT_FOO_BAR_CMD
      local var
      var="AGENT_$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')_CMD"
      echo "${!var:-}"
      ;;
  esac
}

# Detect an exhausted provider usage window in a captured backend log. This is
# deliberately narrower than a generic HTTP 429: the default requires both an
# explicit usage-limit exhaustion and a reset time. Operators may replace the
# ERE with RALPH_QUOTA_REGEX for providers that use different terminal wording.
# On a match, machine-friendly RALPH_QUOTA_* globals are set and persisted when
# RALPH_QUOTA_ARTIFACT names a run artifact. Returns 0 only on a match.
ralph_detect_quota_exhaustion() {  # <logfile> [provider_or_pool]
  local logfile="$1" provider="${2:-unknown}" regex line reset scope observed
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
  RALPH_QUOTA_SCOPE="$scope"
  RALPH_QUOTA_OBSERVED_AT="$observed"
  RALPH_QUOTA_RESET_AT="$reset"
  export RALPH_QUOTA_PROVIDER RALPH_QUOTA_SCOPE RALPH_QUOTA_OBSERVED_AT RALPH_QUOTA_RESET_AT
  if [[ -n "${RALPH_QUOTA_ARTIFACT:-}" ]]; then
    {
      echo "STATUS=PROVIDER_QUOTA_EXHAUSTED"
      echo "PROVIDER=$RALPH_QUOTA_PROVIDER"
      echo "SCOPE=$RALPH_QUOTA_SCOPE"
      echo "OBSERVED_AT=$RALPH_QUOTA_OBSERVED_AT"
      echo "RESET_AT=$RALPH_QUOTA_RESET_AT"
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
# (needs MAX_THINKING_TOKENS, which can't ride in the command string); opencode/droid
# ignore it. Reviewer read-only is preserved: codex uses --sandbox read-only, and
# every builder's permission-skip flag is stripped by strip_autoapprove downstream.
ralph_effort_flag() {  # <provider> <effort>
  [[ -n "$2" ]] || return 0
  case "$1" in
    codex) printf ' -c model_reasoning_effort=%s' "$2" ;;
    *)     : ;;
  esac
}

ralph_provider_cmd() {  # <mode: build|review> <provider> <model> <effort>
  local mode="$1" provider="$2" model="$3" effort="$4" e mflag
  e="$(ralph_effort_flag "$provider" "$effort")"
  case "$provider" in
    codex)
      mflag=""; [[ -n "$model" ]] && mflag=" -m $model"
      if [[ "$mode" == "review" ]]; then
        printf 'codex exec --sandbox read-only%s%s -' "$mflag" "$e"
      else
        printf 'codex exec --yolo --skip-git-repo-check%s%s -' "$mflag" "$e"
      fi ;;
    claude)
      mflag=""; [[ -n "$model" ]] && mflag=" --model $model"
      printf 'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL claude%s -p --dangerously-skip-permissions' "$mflag" ;;
    opencode)
      mflag=""; [[ -n "$model" ]] && mflag=" --model $model"
      printf 'opencode run%s' "$mflag" ;;
    droid)
      printf 'droid exec --skip-permissions-unsafe -f {prompt}' ;;
    *)
      # Unknown provider name: fall back to a same-named backend template if one exists.
      printf '%s' "$(resolve_backend_cmd "$provider")" ;;
  esac
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
  # Act only if the operator asked for normalized selection.
  [[ -n "${RALPH_PROFILE:-}${BUILDER_PROVIDER:-}${REVIEWER_PROVIDER:-}${BUILDER_MODEL:-}${REVIEWER_MODEL:-}${BUILDER_EFFORT:-}${REVIEWER_EFFORT:-}" ]] || return 0
  [[ -n "${RALPH_PROFILE:-}" ]] && ralph_apply_profile "$RALPH_PROFILE"
  : "${BUILDER_PROVIDER:=codex}" "${REVIEWER_PROVIDER:=codex}"
  AGENT_RALPH_BUILD_CMD="$(ralph_provider_cmd build "$BUILDER_PROVIDER" "${BUILDER_MODEL:-}" "${BUILDER_EFFORT:-}")"
  AGENT_RALPH_REVIEW_CMD="$(ralph_provider_cmd review "$REVIEWER_PROVIDER" "${REVIEWER_MODEL:-}" "${REVIEWER_EFFORT:-}")"
  export AGENT_RALPH_BUILD_CMD AGENT_RALPH_REVIEW_CMD
  # Point the roles at the synthetic backends unless already pinned (flag/env wins).
  : "${BUILDER:=ralph-build}" "${REVIEWER:=ralph-review}"
}
# NOTE: the loops (batch-loop.sh / review-loop.sh) call ralph_resolve_role_agents
# AFTER sourcing config.local.sh, so the operator's specs are in scope. Do NOT call
# it here at source time — agents.sh is sourced before config.local.sh.
