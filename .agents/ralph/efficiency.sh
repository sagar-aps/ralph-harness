#!/usr/bin/env bash
# Efficiency mode (#59) — opt-in plumbing + boot validation.
#
# GOVERNS NOTHING in this slice. Sourcing this file and calling
# ralph_efficiency_boot_validate parses the profile and reports its state; it does
# not touch BUILDER/REVIEWER selection, does not enforce a reserve, and does not
# dispatch. Selection is wired in a later slice (#54 step 4c).
#
# Contract (why every path returns instead of dying): a bad profile must never take
# the harness down. Boot validation REJECTS an invalid profile to an inert/off state
# with a loud stderr warning and returns non-zero *as a status*, so callers can keep
# running the normal --builder/--reviewer path unchanged.
#
# Bash 3.2 compatible (no associative arrays, no ${v,,}, no python heredocs).

RALPH_EFFICIENCY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# True when the operator opted in via --efficiency / RALPH_EFFICIENCY.
ralph_efficiency_enabled() {
  local flag
  flag="$(printf '%s' "${RALPH_EFFICIENCY:-}" | tr '[:upper:]' '[:lower:]')"
  case "$flag" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

ralph_efficiency_script_path() {
  printf '%s' "$RALPH_EFFICIENCY_DIR/efficiency.py"
}

# Where the profile lives: RALPH_EFFICIENCY_PROFILE wins, else the target repo copy.
ralph_efficiency_profile_path() {  # <target-repo>
  local repo="${1:-$PWD}"
  if [[ -n "${RALPH_EFFICIENCY_PROFILE:-}" ]]; then
    printf '%s' "$RALPH_EFFICIENCY_PROFILE"
  else
    printf '%s' "$repo/.agents/ralph/efficiency.json"
  fi
}

# Parse + validate the profile at boot. Sets RALPH_EFFICIENCY_STATE to
# valid | not_configured | rejected and returns 0 only when a valid profile is
# active. NEVER exits; a caller under `set -e` must use it in a conditional.
ralph_efficiency_boot_validate() {  # <target-repo>
  local repo="${1:-$PWD}" script json rc=0 status=""
  script="$(ralph_efficiency_script_path)"
  RALPH_EFFICIENCY_PROFILE_PATH="$(ralph_efficiency_profile_path "$repo")"
  RALPH_EFFICIENCY_STATE="rejected"
  export RALPH_EFFICIENCY_STATE RALPH_EFFICIENCY_PROFILE_PATH

  if [[ ! -f "$script" ]]; then
    echo "⚠⚠ ralph: efficiency.py not found at $script — efficiency mode OFF (inert)." >&2
    return 1
  fi

  # `validate` prints its own loud stderr warning for a rejected profile and always
  # exits 0 for profile problems; a non-zero rc here means python3 itself is broken.
  json="$(python3 "$script" validate --repo "$repo" --profile "$RALPH_EFFICIENCY_PROFILE_PATH" --json)" || rc=$?
  if [[ "$rc" -ne 0 || -z "$json" ]]; then
    echo "⚠⚠ ralph: could not run $script (exit $rc) — efficiency mode OFF (inert)." >&2
    return 1
  fi

  status="$(printf '%s\n' "$json" | sed -n 's/.*"status": *"\([a-z_]*\)".*/\1/p' | head -n1)" || status=""
  case "$status" in
    valid)
      RALPH_EFFICIENCY_STATE="valid"
      echo "efficiency: profile $RALPH_EFFICIENCY_PROFILE_PATH is VALID (parsed only — governs nothing in this slice; run 'ralph explain --complexity <level>')."
      return 0
      ;;
    not_configured)
      RALPH_EFFICIENCY_STATE="not_configured"
      echo "efficiency profile not configured (looked for $RALPH_EFFICIENCY_PROFILE_PATH) — efficiency mode OFF (inert)."
      return 1
      ;;
    *)
      RALPH_EFFICIENCY_STATE="rejected"
      echo "efficiency: profile $RALPH_EFFICIENCY_PROFILE_PATH was REJECTED (see the warning above) — efficiency mode OFF (inert); builder/reviewer selection is unchanged."
      return 1
      ;;
  esac
}
