#!/usr/bin/env bash
# Resolve the identity wrapper following the precedence order:
#   1. ralph.target.json identity.marker (if enabled=true)
#   2. $RALPH_IDENTITY_WRAPPER environment variable
#   3. .agents/ralph/identity.sh (if executable)
#   4. ambient gh (fallback)
#
# Outputs:
#   - When resolved: prints the wrapper path and exits 0
#   - When degraded: prints "DEGRADED" and exits 0
#   - When fallback (no marker): prints "FALLBACK" and exits 0
#
# Usage:
#   source .agents/ralph/resolve-identity.sh
#   # After sourcing: $RESOLVED_WRAPPER, $IDENTITY_STATUS, $IDENTITY_SOURCE
#
# Environment:
#   TARGET_REPO      Path to target repo (for ralph.target.json lookup)
#   RALPH_IDENTITY_WRAPPER  Override wrapper path
#
# Test mode:
#   RALPH_TEST_IDENTITY_RESOLVE=1  Sets up test outputs without executing wrappers

set -euo pipefail

# Allow this to be sourced or run directly
if [[ "${RALPH_TEST_IDENTITY_RESOLVE:-}" != "1" && "${1:-}" == "--test" ]]; then
  RALPH_TEST_IDENTITY_RESOLVE=1
fi

resolve_identity() {
  local target_repo="${TARGET_REPO:-}"
  local config_file=""
  local marker_enabled=""
  local marker_wrapper=""
  local marker_role=""
  local env_wrapper="${RALPH_IDENTITY_WRAPPER:-}"
  local default_wrapper=".agents/ralph/identity.sh"
  local resolved=""
  local status=""
  local source=""

  # Determine target repo if not set
  if [[ -z "$target_repo" ]]; then
    target_repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  fi

  # Check for ralph.target.json
  if [[ -n "$target_repo" && -f "$target_repo/ralph.target.json" ]]; then
    config_file="$target_repo/ralph.target.json"
    # Parse identity marker from config
    eval "$(python3 - "$config_file" 2>/dev/null <<'PY'
import json, sys, shlex
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
i = d.get("identity", {}) if isinstance(d, dict) else {}
def emit(k, v):
    if v is None: v = ""
    if isinstance(v, bool): v = "true" if v else "false"
    print(f"{k}={shlex.quote(str(v))}")
emit("marker_enabled", i.get("enabled"))
emit("marker_wrapper", i.get("wrapper"))
emit("marker_role", i.get("role"))
PY
)" || true
  fi

  # Resolution order (high to low priority):

  # 1. ralph.target.json identity.marker (if enabled=true)
  if [[ "$marker_enabled" == "true" ]]; then
    # Marker is present and enabled - this is the authoritative source
    if [[ -n "$marker_wrapper" ]]; then
      # Check if the wrapper exists and is executable
      if [[ -x "$marker_wrapper" ]]; then
        resolved="$marker_wrapper"
        status="resolved"
        source="marker"
      elif [[ -f "$marker_wrapper" ]]; then
        # File exists but not executable - degraded
        resolved=""
        status="degraded"
        source="marker-not-executable"
      else
        # Wrapper doesn't exist - degraded
        resolved=""
        status="degraded"
        source="marker-not-found"
      fi
    else
      # Marker enabled but no wrapper specified - degraded
      resolved=""
      status="degraded"
      source="marker-no-wrapper"
    fi
    # When marker is present and enabled, don't fall through to other options
    # Even if it failed, we're in degraded mode, not fallback
    if [[ "$status" == "degraded" ]]; then
      export RESOLVED_WRAPPER="$resolved"
      export IDENTITY_STATUS="$status"
      export IDENTITY_SOURCE="$source"
      export IDENTITY_MARKER_ENABLED="$marker_enabled"
      export IDENTITY_MARKER_ROLE="$marker_role"
      return 0
    fi
  fi

  # 2. $RALPH_IDENTITY_WRAPPER environment variable
  if [[ -z "$resolved" && -n "$env_wrapper" ]]; then
    if [[ -x "$env_wrapper" ]]; then
      resolved="$env_wrapper"
      status="resolved"
      source="env"
    elif [[ -f "$env_wrapper" ]]; then
      # File exists but not executable - fallback (no marker)
      resolved=""
      status="fallback"
      source="env-not-executable"
    else
      # File doesn't exist - fallback (no marker)
      resolved=""
      status="fallback"
      source="env-not-found"
    fi
  fi

  # 3. .agents/ralph/identity.sh (if executable)
  if [[ -z "$resolved" && -n "$target_repo" ]]; then
    local identity_sh="$target_repo/$default_wrapper"
    if [[ -x "$identity_sh" ]]; then
      resolved="$identity_sh"
      status="resolved"
      source="default"
    elif [[ -f "$identity_sh" ]]; then
      # File exists but not executable - fallback (no marker)
      resolved=""
      status="fallback"
      source="default-not-executable"
    else
      # File doesn't exist - fallback to ambient gh (no marker)
      resolved=""
      status="fallback"
      source="default-not-found"
    fi
  fi

  # Export results
  export RESOLVED_WRAPPER="$resolved"
  export IDENTITY_STATUS="$status"
  export IDENTITY_SOURCE="$source"
  export IDENTITY_MARKER_ENABLED="$marker_enabled"
  export IDENTITY_MARKER_ROLE="$marker_role"
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  # Executed directly (not sourced): print a summary and set an exit code, unless
  # a caller is driving resolve_identity via the test harness (RALPH_TEST_IDENTITY_RESOLVE=1).
  if [[ "${RALPH_TEST_IDENTITY_RESOLVE:-}" != "1" ]]; then
    resolve_identity
    case "$IDENTITY_STATUS" in
      resolved)
        echo "$RESOLVED_WRAPPER"
        exit 0
        ;;
      degraded)
        echo "DEGRADED"
        exit 0
        ;;
      fallback)
        echo "FALLBACK"
        exit 0
        ;;
      *)
        echo "ERROR: unexpected status $IDENTITY_STATUS" >&2
        exit 1
        ;;
    esac
  else
    resolve_identity
  fi
else
  # Sourced: this is the documented usage (`source .agents/ralph/resolve-identity.sh`
  # then read $IDENTITY_STATUS etc.) — resolve unconditionally so the caller's shell
  # actually gets populated vars instead of silently inheriting nothing.
  resolve_identity
fi
