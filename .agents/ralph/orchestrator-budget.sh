#!/usr/bin/env bash
# Proactive user-defined ceiling over the observable builder+reviewer token total.
# Unknown round totals remain unknown in round-usage.jsonl and contribute zero here.

ralph_orchestrator_budget_refresh() {  # <run-dir>
  local run_dir="$1" state_file="$1/orchestrator-budget.env" rc

  RALPH_BUDGET_CONFIGURED="false"
  RALPH_BUDGET_REACHED="false"
  RALPH_BUDGET_TOKENS="${RALPH_ORCHESTRATOR_BUDGET_TOKENS:-}"
  RALPH_BUDGET_STOP_PCT="${RALPH_ORCHESTRATOR_STOP_PCT:-100}"
  RALPH_BUDGET_THRESHOLD_TOKENS=""
  RALPH_BUDGET_OBSERVED_TOKENS="0"
  RALPH_BUDGET_UNKNOWN_ROUNDS="0"
  [[ -n "$RALPH_BUDGET_TOKENS" ]] || return 1

  python3 - "$run_dir/round-usage.jsonl" "$RALPH_BUDGET_TOKENS" \
    "$RALPH_BUDGET_STOP_PCT" "$state_file" <<'PY'
from decimal import Decimal, InvalidOperation
import json
import os
import sys

usage_file, raw_budget, raw_pct, state_file = sys.argv[1:]
try:
    budget = Decimal(raw_budget)
    pct = Decimal(raw_pct)
except InvalidOperation:
    print("ralph: RALPH_ORCHESTRATOR_BUDGET_TOKENS and RALPH_ORCHESTRATOR_STOP_PCT must be numbers", file=sys.stderr)
    sys.exit(2)
if not budget.is_finite() or budget <= 0 or not pct.is_finite() or pct <= 0:
    print("ralph: RALPH_ORCHESTRATOR_BUDGET_TOKENS and RALPH_ORCHESTRATOR_STOP_PCT must be greater than zero", file=sys.stderr)
    sys.exit(2)

observed = Decimal(0)
unknown = 0
if os.path.isfile(usage_file):
    with open(usage_file, encoding="utf-8") as handle:
        for line in handle:
            try:
                value = json.loads(line)
                total = value.get("tokens", {}).get("total")
                if isinstance(total, bool) or not isinstance(total, (int, float)):
                    unknown += 1
                    continue
                observed += Decimal(str(total))
            except (ValueError, AttributeError):
                unknown += 1

threshold = budget * pct / Decimal(100)
reached = observed >= threshold

def shown(value):
    value = value.normalize()
    return format(value, "f")

with open(state_file, "w", encoding="utf-8") as handle:
    handle.write("RALPH_BUDGET_CONFIGURED=true\n")
    handle.write("RALPH_BUDGET_REACHED={}\n".format("true" if reached else "false"))
    handle.write("RALPH_BUDGET_TOKENS={}\n".format(shown(budget)))
    handle.write("RALPH_BUDGET_STOP_PCT={}\n".format(shown(pct)))
    handle.write("RALPH_BUDGET_THRESHOLD_TOKENS={}\n".format(shown(threshold)))
    handle.write("RALPH_BUDGET_OBSERVED_TOKENS={}\n".format(shown(observed)))
    handle.write("RALPH_BUDGET_UNKNOWN_ROUNDS={}\n".format(unknown))
sys.exit(0 if reached else 1)
PY
  rc=$?
  [[ "$rc" -eq 0 || "$rc" -eq 1 ]] || return "$rc"
  # Values are emitted only from validated Decimal values and integer counters.
  # shellcheck source=/dev/null
  . "$state_file"
  return "$rc"
}
