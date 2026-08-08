#!/usr/bin/env bash
# Per-pool usage state (#60) — the shell entry point for usage-state.py.
#
# READ-ONLY: it reads <target-repo>/.ralph/ledger.jsonl and the efficiency profile
# and prints the per-pool 5h/weekly token sums, the pct (only when the profile
# configures a token budget for that window), the reset proximity and whether a
# rung's avoid window is active now. It writes nothing, calls no provider API,
# enforces no cap or reserve, and changes no selection.
#
# Sourced:  ralph_usage_state_json <target-repo> [profile-path]
#           ralph_usage_state_report <target-repo> [profile-path]
# Executed: usage-state.sh --repo <target-repo> [--profile PATH] [--json]
#
# Bash 3.2 compatible.

RALPH_USAGE_STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ralph_usage_state_script_path() {
  printf '%s' "$RALPH_USAGE_STATE_DIR/usage-state.py"
}

# Run the reader. Returns non-zero (without printing python noise) when the
# helper is missing, so a caller can carry on without usage numbers.
ralph_usage_state() {  # <target-repo> [profile-path] [extra args...]
  local repo="${1:-$PWD}" profile="${2:-}" script
  shift $(( $# > 2 ? 2 : $# ))
  script="$(ralph_usage_state_script_path)"
  if [[ ! -f "$script" ]]; then
    echo "ralph: usage-state.py not found at $script — no per-pool usage state." >&2
    return 1
  fi
  if [[ -n "$profile" ]]; then
    python3 "$script" --repo "$repo" --profile "$profile" "$@"
  else
    python3 "$script" --repo "$repo" "$@"
  fi
}

ralph_usage_state_json() {  # <target-repo> [profile-path]
  ralph_usage_state "${1:-$PWD}" "${2:-}" --json
}

ralph_usage_state_report() {  # <target-repo> [profile-path]
  ralph_usage_state "${1:-$PWD}" "${2:-}"
}

# Executed directly: forward the CLI through to the python reader.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  script="$(ralph_usage_state_script_path)"
  if [[ ! -f "$script" ]]; then
    echo "ralph: usage-state.py not found at $script" >&2
    exit 1
  fi
  exec python3 "$script" "$@"
fi
