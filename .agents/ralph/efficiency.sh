#!/usr/bin/env bash
# Efficiency mode (#59) — opt-in plumbing + boot validation (#59), selection (#61),
# dispatch wiring (#62).
#
# ralph_efficiency_boot_validate parses the profile and reports its state;
# ralph_efficiency_select computes which rung a complexity tier would use (enforcing
# the caps, avoid windows, the #28 circuit and the weekly reserves) and reports it in
# RALPH_EFFICIENCY_SELECT_*; ralph_efficiency_dispatch_select (#62) turns that
# recommendation into an instruction for ONE ticket — but only under the opt-in.
#
# DEFAULT OFF IS SACRED: with --efficiency / RALPH_EFFICIENCY unset, every function
# here returns before doing anything, so BUILDER/REVIEWER dispatch is exactly the
# --builder/--reviewer path it has always been.
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
      echo "efficiency: profile $RALPH_EFFICIENCY_PROFILE_PATH is VALID — tickets carrying a complexity:<tier> label/field are right-sized from it (run 'ralph explain --complexity <level>' to read the policy)."
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
# the mode on. The loops reach it only through ralph_efficiency_dispatch_select
# below, which does check the opt-in (#62).
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

# --- Dispatch (#62) ---------------------------------------------------------
#
# The seam where a recommendation becomes an assignment, for ONE ticket at a time.
# It is the only thing in efficiency mode that can change who runs, and it refuses
# to do so unless the operator opted in: ralph_efficiency_enabled is the first gate,
# a VALID profile is the second, and a complexity tier on the ticket is the third.
# Anything missing means INERT — the caller keeps the builder/reviewer it already
# resolved and the run continues, loudly but normally.

# The complexity tier a ticket declares, read out of its text: a `complexity:<tier>`
# label (the Manager assigns exactly one per implementable issue — see LABELS.md) or
# a `Complexity: <tier>` field. Prints the tier, or nothing when there is none.
ralph_efficiency_complexity_from_text() {  # <text>
  printf '%s\n' "${1:-}" | tr 'A-Z' 'a-z' \
    | sed -n -E 's/.*complexity[[:space:]]*[:=][[:space:]]*[^a-z]*(trivial|small|medium|large).*/\1/p' \
    | head -n1
}

# Decide what to do about one ticket. Returns:
#   0 = APPLIED — the caller MUST set its BUILDER/REVIEWER from
#       RALPH_EFFICIENCY_SELECT_BUILDER/_REVIEWER and re-resolve their commands.
#   3 = PAUSED  — bounded PAUSE from #61: the caller must stop CLEANLY (flush what it
#       has, keep artifacts, publish the reason). Never a crash.
#   4 = INERT   — efficiency is off, unusable, or the ticket has no complexity tier:
#       the caller changes nothing.
# Sets RALPH_EFFICIENCY_DISPATCH_STATE (off|inert|no-complexity|applied|paused) plus
# _NOTE / _TICKET / _COMPLEXITY for the run record, the ledger and the PR body.
# NEVER exits; a caller under `set -e` must use it in a conditional.
ralph_efficiency_dispatch_select() {  # <complexity> <target-repo> <ticket-label>
  local complexity="${1:-}" repo="${2:-$PWD}" ticket="${3:-ticket}" rc=0
  RALPH_EFFICIENCY_DISPATCH_STATE="off"
  RALPH_EFFICIENCY_DISPATCH_NOTE=""
  RALPH_EFFICIENCY_DISPATCH_TICKET="$ticket"
  RALPH_EFFICIENCY_DISPATCH_COMPLEXITY="$complexity"
  export RALPH_EFFICIENCY_DISPATCH_STATE RALPH_EFFICIENCY_DISPATCH_NOTE \
    RALPH_EFFICIENCY_DISPATCH_TICKET RALPH_EFFICIENCY_DISPATCH_COMPLEXITY

  # Gate 1 — the opt-in. Without it this function is the only efficiency code a loop
  # runs, and it stops here: dispatch stays byte-for-byte today's behavior.
  ralph_efficiency_enabled || return 4

  # Past the opt-in, forget the previous ticket's decision: an INERT gate below never
  # reaches ralph_efficiency_select (which does its own reset), and a stale rung would
  # then be recorded against a ticket that was never right-sized.
  RALPH_EFFICIENCY_SELECT_STATUS=""; RALPH_EFFICIENCY_SELECT_RUNG=""
  RALPH_EFFICIENCY_SELECT_BUILDER=""; RALPH_EFFICIENCY_SELECT_BUILDER_POOL=""
  RALPH_EFFICIENCY_SELECT_REVIEWER=""; RALPH_EFFICIENCY_SELECT_REVIEWER_POOL=""
  RALPH_EFFICIENCY_SELECT_REASON=""; RALPH_EFFICIENCY_SELECT_PAUSE_SECONDS=""
  RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL=""

  # Gate 2 — a profile that boot validation accepted. A missing/rejected one already
  # warned loudly at boot; say plainly that this ticket falls back to normal dispatch.
  if [[ "${RALPH_EFFICIENCY_STATE:-}" != "valid" ]]; then
    RALPH_EFFICIENCY_DISPATCH_STATE="inert"
    RALPH_EFFICIENCY_DISPATCH_NOTE="profile ${RALPH_EFFICIENCY_STATE:-unavailable} — normal --builder/--reviewer dispatch"
    echo "⚠⚠ ralph: efficiency mode is ON but the profile is ${RALPH_EFFICIENCY_STATE:-unavailable} — $ticket dispatches on the normal --builder/--reviewer path (inert)." >&2
    return 4
  fi

  # Gate 3 — the ticket's own complexity. Guessing a tier would silently right-size a
  # ticket nobody sized, so an unlabelled ticket keeps the operator's own selection.
  if [[ -z "$complexity" ]]; then
    RALPH_EFFICIENCY_DISPATCH_STATE="no-complexity"
    RALPH_EFFICIENCY_DISPATCH_NOTE="no complexity:<tier> label/field on $ticket — normal --builder/--reviewer dispatch"
    echo "⚠⚠ ralph: efficiency mode is ON but $ticket carries no complexity:<tier> label/field — nothing to right-size it by; dispatching on the normal --builder/--reviewer path." >&2
    return 4
  fi

  ralph_efficiency_select "$complexity" "$repo" || rc=$?
  case "$rc" in
    0)
      RALPH_EFFICIENCY_DISPATCH_STATE="applied"
      RALPH_EFFICIENCY_DISPATCH_NOTE="rung $RALPH_EFFICIENCY_SELECT_RUNG (complexity $complexity): $RALPH_EFFICIENCY_SELECT_REASON"
      return 0
      ;;
    3)
      RALPH_EFFICIENCY_DISPATCH_STATE="paused"
      RALPH_EFFICIENCY_DISPATCH_NOTE="$RALPH_EFFICIENCY_SELECT_REASON"
      return 3
      ;;
    *)
      RALPH_EFFICIENCY_DISPATCH_STATE="inert"
      RALPH_EFFICIENCY_DISPATCH_NOTE="selection unusable (${RALPH_EFFICIENCY_SELECT_REASON:-no reason reported}) — normal --builder/--reviewer dispatch"
      echo "⚠⚠ ralph: efficiency selection for $ticket was inert — $RALPH_EFFICIENCY_DISPATCH_NOTE." >&2
      return 4
      ;;
  esac
}

# One line describing what efficiency did for this ticket, for banners, the final
# report and the PR/handoff body. Prints nothing when the mode is off, so callers
# can append it unconditionally without changing the default output.
ralph_efficiency_dispatch_summary() {
  case "${RALPH_EFFICIENCY_DISPATCH_STATE:-off}" in
    off|"") return 0 ;;
    applied)
      printf 'efficiency: rung %s (complexity %s) -> builder %s (pool %s), reviewer %s (pool %s) — %s' \
        "$RALPH_EFFICIENCY_SELECT_RUNG" "$RALPH_EFFICIENCY_DISPATCH_COMPLEXITY" \
        "$RALPH_EFFICIENCY_SELECT_BUILDER" "$RALPH_EFFICIENCY_SELECT_BUILDER_POOL" \
        "$RALPH_EFFICIENCY_SELECT_REVIEWER" "$RALPH_EFFICIENCY_SELECT_REVIEWER_POOL" \
        "$RALPH_EFFICIENCY_SELECT_REASON"
      ;;
    paused)
      printf 'efficiency: PAUSED before dispatch — %s' "$RALPH_EFFICIENCY_DISPATCH_NOTE"
      ;;
    *)
      printf 'efficiency: %s (%s) — selection unchanged' \
        "$RALPH_EFFICIENCY_DISPATCH_STATE" "$RALPH_EFFICIENCY_DISPATCH_NOTE"
      ;;
  esac
}

# Append this ticket's decision to <run-dir>/efficiency-dispatch.jsonl so the run
# carries an auditable record of who was chosen and why. No-op when the mode is off.
ralph_efficiency_dispatch_record() {  # <run-dir>
  local run_dir="${1:-}"
  [[ -n "$run_dir" && -d "$run_dir" ]] || return 0
  case "${RALPH_EFFICIENCY_DISPATCH_STATE:-off}" in off|"") return 0 ;; esac
  python3 - "$run_dir/efficiency-dispatch.jsonl" \
    "$RALPH_EFFICIENCY_DISPATCH_TICKET" "$RALPH_EFFICIENCY_DISPATCH_COMPLEXITY" \
    "$RALPH_EFFICIENCY_DISPATCH_STATE" "$RALPH_EFFICIENCY_DISPATCH_NOTE" \
    "${RALPH_EFFICIENCY_SELECT_RUNG:-}" "${RALPH_EFFICIENCY_SELECT_BUILDER:-}" \
    "${RALPH_EFFICIENCY_SELECT_BUILDER_POOL:-}" "${RALPH_EFFICIENCY_SELECT_REVIEWER:-}" \
    "${RALPH_EFFICIENCY_SELECT_REVIEWER_POOL:-}" "${RALPH_EFFICIENCY_SELECT_REASON:-}" \
    "${RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL:-}" "${RALPH_EFFICIENCY_SELECT_NOW:-}" <<'PY'
import json, sys
(path, ticket, complexity, state, note, rung, builder, builder_pool,
 reviewer, reviewer_pool, reason, pause_until, now) = sys.argv[1:14]
record = {
    "ticket": ticket,
    "complexity": complexity,
    "state": state,
    "note": note,
    "rung": rung,
    "builder": builder,
    "builder_pool": builder_pool,
    "reviewer": reviewer,
    "reviewer_pool": reviewer_pool,
    "reason": reason,
    "pause_until": pause_until,
    "decided_at": now,
}
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
PY
}
