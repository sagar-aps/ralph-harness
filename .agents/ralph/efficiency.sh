#!/usr/bin/env bash
# Efficiency mode (#59) — opt-in plumbing + boot validation + selection (#61).
#
# DISPATCHES NOTHING. Sourcing this file and calling ralph_efficiency_boot_validate
# parses the profile and reports its state; ralph_efficiency_select computes which
# rung a complexity tier WOULD use (enforcing the caps, avoid windows, the #28
# circuit and the weekly reserves) and reports it in RALPH_EFFICIENCY_SELECT_*.
# Neither touches BUILDER/REVIEWER or runs an agent — wiring the recommendation
# into dispatch is a later slice (#54 step 4d).
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

# --- Selection (#61) --------------------------------------------------------

# Print the credential pools whose #28 quota circuit is currently OPEN, one per
# line. The decision itself is NOT re-implemented here: ralph_quota_pool_is_exhausted
# (agents.sh) owns it, including "the reset time has elapsed, forget the circuit".
# Only a pool that has a circuit record can be exhausted, so the records are the
# complete candidate list.
ralph_efficiency_open_circuit_pools() {
  local line pool seen=""
  if ! declare -f ralph_quota_pool_is_exhausted >/dev/null 2>&1; then
    [[ -f "$RALPH_EFFICIENCY_DIR/agents.sh" ]] || return 0
    # shellcheck source=/dev/null
    . "$RALPH_EFFICIENCY_DIR/agents.sh"
    declare -f ralph_quota_pool_is_exhausted >/dev/null 2>&1 || return 0
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    pool="${line%%|*}"
    [[ -n "$pool" ]] || continue
    case " $seen " in *" $pool "*) continue ;; esac
    seen="$seen $pool"
    if ralph_quota_pool_is_exhausted "$pool"; then
      printf '%s\n' "$pool"
    fi
  done <<EOF
${RALPH_QUOTA_OPEN_CIRCUITS:-}
EOF
}

# Which (builder, reviewer) rung the profile would use for a complexity tier.
# READ-ONLY and NON-DISPATCHING: it sets RALPH_EFFICIENCY_SELECT_* and returns a
# status; it never assigns BUILDER/REVIEWER and never runs an agent.
#
#   0 = a rung was selected (RALPH_EFFICIENCY_SELECT_RUNG / _BUILDER / _REVIEWER)
#   3 = bounded PAUSE (nothing eligible, backstop unavailable) — see
#       RALPH_EFFICIENCY_SELECT_PAUSE_SECONDS / _PAUSE_UNTIL
#   4 = efficiency is inert (no profile, rejected profile, or python3 unusable):
#       the caller keeps its normal --builder/--reviewer path unchanged
#
# The opt-in (--efficiency / RALPH_EFFICIENCY) decides whether a caller consults
# this at all — check ralph_efficiency_enabled there. It is deliberately not checked
# here, so `ralph explain` and the fixtures can inspect the decision without turning
# the mode on. No caller consults it yet: nothing in the loops changed (#54 step 4d).
#
# NEVER exits; a caller under `set -e` must use it in a conditional.
ralph_efficiency_select() {  # <complexity> [target-repo]
  local complexity="${1:-}" repo="${2:-$PWD}" script profile pool rc=0 assignments=""
  local pool_args="" open_pools=""
  RALPH_EFFICIENCY_SELECT_STATUS="inert"
  RALPH_EFFICIENCY_SELECT_COMPLEXITY="$complexity"
  RALPH_EFFICIENCY_SELECT_RUNG=""
  RALPH_EFFICIENCY_SELECT_BUILDER=""
  RALPH_EFFICIENCY_SELECT_BUILDER_POOL=""
  RALPH_EFFICIENCY_SELECT_REVIEWER=""
  RALPH_EFFICIENCY_SELECT_REVIEWER_POOL=""
  RALPH_EFFICIENCY_SELECT_BACKSTOP=""
  RALPH_EFFICIENCY_SELECT_PAUSE_SECONDS=""
  RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL=""
  RALPH_EFFICIENCY_SELECT_REASON=""
  RALPH_EFFICIENCY_SELECT_PROFILE=""
  RALPH_EFFICIENCY_SELECT_NOW=""

  if [[ -z "$complexity" ]]; then
    RALPH_EFFICIENCY_SELECT_REASON="ralph_efficiency_select needs a complexity tier"
    echo "⚠⚠ ralph: $RALPH_EFFICIENCY_SELECT_REASON — efficiency selection skipped (inert)." >&2
    return 4
  fi
  script="$(ralph_efficiency_script_path)"
  if [[ ! -f "$script" ]]; then
    RALPH_EFFICIENCY_SELECT_REASON="efficiency.py not found at $script"
    echo "⚠⚠ ralph: $RALPH_EFFICIENCY_SELECT_REASON — efficiency mode OFF (inert)." >&2
    return 4
  fi
  profile="$(ralph_efficiency_profile_path "$repo")"

  # Feed the #28 circuit state in; efficiency.py never derives it itself.
  open_pools="$(ralph_efficiency_open_circuit_pools)"
  while IFS= read -r pool; do
    [[ -n "$pool" ]] || continue
    pool_args="$pool_args --exhausted-pool $pool"
  done <<EOF
$open_pools
EOF

  # --shell prints sourceable KEY=value assignments; a non-zero rc is a STATUS
  # (paused/inert), not a crash, so capture it rather than letting set -e fire.
  # shellcheck disable=SC2086
  assignments="$(python3 "$script" select --complexity "$complexity" --repo "$repo" \
    --profile "$profile" --shell $pool_args)" || rc=$?
  if [[ -z "$assignments" ]]; then
    RALPH_EFFICIENCY_SELECT_REASON="could not run $script (exit $rc)"
    echo "⚠⚠ ralph: $RALPH_EFFICIENCY_SELECT_REASON — efficiency mode OFF (inert)." >&2
    return 4
  fi
  eval "$assignments"
  export RALPH_EFFICIENCY_SELECT_STATUS RALPH_EFFICIENCY_SELECT_COMPLEXITY \
    RALPH_EFFICIENCY_SELECT_RUNG RALPH_EFFICIENCY_SELECT_BUILDER \
    RALPH_EFFICIENCY_SELECT_BUILDER_POOL RALPH_EFFICIENCY_SELECT_REVIEWER \
    RALPH_EFFICIENCY_SELECT_REVIEWER_POOL RALPH_EFFICIENCY_SELECT_BACKSTOP \
    RALPH_EFFICIENCY_SELECT_PAUSE_SECONDS RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL \
    RALPH_EFFICIENCY_SELECT_REASON RALPH_EFFICIENCY_SELECT_PROFILE \
    RALPH_EFFICIENCY_SELECT_NOW
  return "$rc"
}
