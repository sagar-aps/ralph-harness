#!/usr/bin/env bash
# Ralph preflight — repo-contract phase. Runs the target's configured
# install/check/test/e2e commands against the CURRENT checkout (no worktree, no
# agents) so a broken baseline is caught before any build/review/batch work.
#
# Usage:  preflight.sh <repo_dir> [report_path]
# Exit:   0 = passed or skipped (not configured / disabled / --no-preflight)
#         3 = a configured preflight step FAILED (caller should block)
#
# Config lives in <repo_dir>/ralph.target.json:
#   "preflight": {
#     "enabled": true,
#     "install": "npm ci",
#     "check":   "./scripts/check.sh",
#     "test":    "npm test",
#     "e2e":     "",                 // optional; must self-manage any server
#     "commands": ["extra cmd", ...] // optional, run after the named steps
#   }
# Env: PREFLIGHT_SKIP=true bypasses entirely (e.g. --no-preflight).

set -uo pipefail

REPO="${1:?usage: preflight.sh <repo_dir> [report_path]}"
REPORT="${2:-$REPO/.ralph/preflight-last.md}"
REPO="$(cd "$REPO" && pwd)"
mkdir -p "$(dirname "$REPORT")"

now() { date '+%Y-%m-%d %H:%M:%S'; }

skip_report() {
  local reason="$1"
  {
    echo "# Ralph preflight — SKIPPED"
    echo ""
    echo "- Repo: $REPO"
    echo "- Time: $(now)"
    echo "- Reason: $reason"
  } > "$REPORT"
  echo "Preflight skipped: $reason"
  exit 0
}

if [[ "${PREFLIGHT_SKIP:-false}" == "true" ]]; then
  skip_report "bypassed with --no-preflight / PREFLIGHT_SKIP"
fi

# Re-entrancy guard (self-host fork-bomb fix, #35). Ralph exports RALPH_IN_PREFLIGHT=1
# around every check command it runs. If a ralph subprocess spawned by that check
# (e.g. the harness test suite exercises `ralph build/review/batch`) reaches preflight,
# it MUST NOT run it again — otherwise preflight -> npm test -> ralph -> preflight
# recurses into an unbounded fork bomb (once measured at 377 procs / 8.5 GB).
if [[ "${RALPH_IN_PREFLIGHT:-}" == "1" ]]; then
  skip_report "re-entrancy guard: nested inside a ralph-invoked check (RALPH_IN_PREFLIGHT=1)"
fi

CONFIG="$REPO/ralph.target.json"
[[ -f "$CONFIG" ]] || skip_report "no ralph.target.json (nothing configured)"

# Emit the ordered, configured steps as: name<TAB>command
STEPS_TSV="$(python3 - "$CONFIG" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"__ERROR__\t{e}")
    sys.exit(0)
pf = d.get("preflight") if isinstance(d, dict) else None
if not isinstance(pf, dict):
    sys.exit(0)                      # not configured
if pf.get("enabled") is False:
    print("__DISABLED__\t")
    sys.exit(0)
def add(name, cmd):
    if isinstance(cmd, str) and cmd.strip():
        print(f"{name}\t{cmd.strip()}")
for name in ("install", "check", "test", "e2e"):
    add(name, pf.get(name))
extra = pf.get("commands")
if isinstance(extra, list):
    for i, c in enumerate(extra, 1):
        add(f"command-{i}", c if isinstance(c, str) else "")
PY
)"

if [[ -z "$STEPS_TSV" ]]; then
  skip_report "no preflight block configured in ralph.target.json"
fi
if [[ "$STEPS_TSV" == "__DISABLED__"* ]]; then
  skip_report "preflight.enabled is false"
fi
if [[ "$STEPS_TSV" == "__ERROR__"* ]]; then
  echo "Preflight: could not parse $CONFIG" >&2
  skip_report "ralph.target.json is not valid JSON"
fi

LOG_BASE="${REPORT%.md}"
echo "── Preflight (repo contract) in $REPO ──"

declare -a ROWS=()
OVERALL="PASS"
FAILED_STEP=""
FAILED_LOG=""

while IFS=$'\t' read -r NAME CMD; do
  [[ -z "$NAME" ]] && continue
  if [[ "$OVERALL" == "FAIL" ]]; then
    ROWS+=("| $NAME | \`$CMD\` | skipped | - |")
    continue
  fi
  LOG="$LOG_BASE.$NAME.log"
  echo "preflight: $NAME -> $CMD"
  # Mark descendants so a ralph spawned by this check skips its own preflight (#35).
  ( cd "$REPO" && RALPH_IN_PREFLIGHT=1 eval "$CMD" ) > "$LOG" 2>&1
  STATUS=$?
  if [[ "$STATUS" -eq 0 ]]; then
    ROWS+=("| $NAME | \`$CMD\` | PASS | 0 |")
  else
    ROWS+=("| $NAME | \`$CMD\` | FAIL | $STATUS |")
    OVERALL="FAIL"; FAILED_STEP="$NAME"; FAILED_LOG="$LOG"
    echo "preflight: $NAME FAILED (exit $STATUS) — see $LOG"
  fi
done <<< "$STEPS_TSV"

{
  echo "# Ralph preflight — $OVERALL"
  echo ""
  echo "- Repo: $REPO"
  echo "- Time: $(now)"
  echo ""
  echo "| Step | Command | Status | Exit |"
  echo "|------|---------|--------|------|"
  for r in "${ROWS[@]}"; do echo "$r"; done
  if [[ "$OVERALL" == "FAIL" ]]; then
    echo ""
    echo "## Failed step: $FAILED_STEP"
    echo ""
    echo "Last 50 lines of $FAILED_LOG:"
    echo '```'
    tail -n 50 "$FAILED_LOG" 2>/dev/null
    echo '```'
    echo ""
    echo "This is a REPO-CONTRACT failure (the baseline repo is not healthy)."
    echo "Fix the repo setup before running build/review/batch. Agents should propose"
    echo "minimal repo-contract fixes, not implement PRDs, while preflight is failing."
  fi
} > "$REPORT"

if [[ "$OVERALL" == "FAIL" ]]; then
  echo "Preflight FAILED at step '$FAILED_STEP'. Report: $REPORT"
  exit 3
fi
echo "Preflight passed. Report: $REPORT"
exit 0
