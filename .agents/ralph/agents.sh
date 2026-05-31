#!/usr/bin/env bash
# Default agent command templates (used by loop.sh and CLI).

AGENT_CODEX_CMD="codex exec --yolo --skip-git-repo-check -"
AGENT_CODEX_INTERACTIVE_CMD="codex --yolo {prompt}"
AGENT_CLAUDE_CMD="claude -p --dangerously-skip-permissions \"\$(cat {prompt})\""
AGENT_CLAUDE_INTERACTIVE_CMD="claude --dangerously-skip-permissions {prompt}"
AGENT_DROID_CMD="droid exec --skip-permissions-unsafe -f {prompt}"
AGENT_DROID_INTERACTIVE_CMD="droid --skip-permissions-unsafe {prompt}"
AGENT_OPENCODE_CMD="opencode run \"\$(cat {prompt})\""
AGENT_OPENCODE_INTERACTIVE_CMD="opencode --prompt {prompt}"
# Uncomment to use server mode (faster, avoids cold boot):
# AGENT_OPENCODE_CMD="opencode run --attach http://localhost:4096 \"\$(cat {prompt})\""
# AGENT_OPENCODE_INTERACTIVE_CMD="opencode --prompt {prompt} --attach http://localhost:4096"

# --- Extra backends for the builder/reviewer review loop ---
# Guarded assignments (only set if not already provided via env/config) so that
# templates containing `{prompt}` don't trip bash brace-matching in `${VAR:-...}`.
# "opencode-z" is OpenCode authenticated with the Z.AI Coding Plan. Same binary
# as opencode; named separately so a role can pin it explicitly.
[[ -n "${AGENT_OPENCODE_Z_CMD:-}" ]] || AGENT_OPENCODE_Z_CMD='opencode run "$(cat {prompt})"'
# Codex with a writable sandbox (good default for a builder role).
[[ -n "${AGENT_CODEX_WRITE_CMD:-}" ]] || AGENT_CODEX_WRITE_CMD='codex exec --sandbox workspace-write -'
# Codex with a read-only sandbox (good default for a reviewer role).
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
