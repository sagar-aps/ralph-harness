#!/usr/bin/env bash
# Example USAGE PROVIDER adapter (#68) — the contract, and a working implementation.
#
# WHY THIS EXISTS
# Efficiency caps and reserves only bind when the harness knows what percentage of a
# window a pool has spent. For most pools that percentage is computed locally: ledger
# tokens / the `window_*_budget_tokens` budget in the profile. Some providers publish
# usage ONLY as a percentage and sell no token budget at all — an Anthropic Pro/Max
# plan is the case that matters, because that is the pool the manager runs on. Without
# an adapter its pct stays unknown, so its cap and the manager reserve fail open.
#
# A pool points at an adapter from its cap block in .agents/ralph/efficiency.json:
#
#   "caps": {
#     "anthropic": {
#       "source": "provider_pct",
#       "usage_provider": ".agents/ralph/usage_provider.sh",
#       "window_5h_pct": 80,
#       "window_weekly_pct": 75
#     }
#   }
#
# `source: "provider_pct"` REQUIRES `usage_provider`. The two window percentages are
# optional: with them the harness caps the pool at that share of the window; without
# them it applies no cap of its own but still uses the reported percentage for the
# weekly reserves. A relative `usage_provider` path is resolved against the target repo.
#
# THE CONTRACT
#   * argv:  $1 = pool name, $2 = absolute path of the target repo.
#     Same values in $RALPH_USAGE_PROVIDER_POOL / $RALPH_USAGE_PROVIDER_REPO.
#   * cwd:   the target repo.
#   * stdout: EXACTLY one JSON object, and nothing else:
#       {"window_5h_pct": 41.0, "window_weekly_pct": 63.5,
#        "weekly_reset_at": "2026-08-12T09:00:00Z"}
#     - window_5h_pct / window_weekly_pct: numbers 0-100 (percent of that window
#       already SPENT). Either may be omitted or null when you do not know it — that
#       window then falls back to the ledger/budget path.
#     - weekly_reset_at: ISO-8601 UTC. Optional, but it is what makes the weekly reset
#       (and the near-weekly-reset relaxation of the weekly gates) knowable.
#   * exit 0 on success. ANY other outcome — non-zero exit, no output, unparseable
#     output, a timeout (20s, or $RALPH_USAGE_PROVIDER_TIMEOUT; the script and anything
#     it spawned are then killed), a number outside 0-100 — makes the harness FAIL OPEN:
#     pct stays "unknown", no cap or reserve binds on that number, and the hard quota
#     circuit remains the real gate. Never print a guess; failing open is the
#     designed, safe answer.
#   * Be read-only, be quick, and be quiet on stdout (diagnostics go to stderr).
#
# THIS IMPLEMENTATION
# There is no portable way to query every provider's usage, so this adapter does not
# try: it PUBLISHES numbers that something else in your setup already collected.
#   1. $RALPH_USAGE_5H_PCT / $RALPH_USAGE_WEEKLY_PCT / $RALPH_USAGE_WEEKLY_RESET_AT
#      when set — the manual/ops path.
#   2. Otherwise a cache file: $RALPH_USAGE_PROVIDER_CACHE, or
#      <repo>/.ralph/usage-provider-<pool>.json. Write it from whatever queryer you
#      have (a cron job that reads your plan's usage page or API) in exactly the
#      output format above. Refresh it often: this adapter cannot tell a fresh number
#      from a stale one, and a stale percentage is worse than an unknown one.
#   3. Neither available -> exit non-zero so the harness fails open.
#
# Copy to .agents/ralph/usage_provider.sh (gitignore it if it holds anything private),
# chmod +x, and point your cap at it.
set -euo pipefail

pool="${1:-${RALPH_USAGE_PROVIDER_POOL:-unknown}}"
repo="${2:-${RALPH_USAGE_PROVIDER_REPO:-$PWD}}"

# 1) Explicit env override.
if [[ -n "${RALPH_USAGE_5H_PCT:-}" || -n "${RALPH_USAGE_WEEKLY_PCT:-}" ]]; then
  fields=""
  [[ -n "${RALPH_USAGE_5H_PCT:-}" ]] && fields="\"window_5h_pct\": ${RALPH_USAGE_5H_PCT}"
  if [[ -n "${RALPH_USAGE_WEEKLY_PCT:-}" ]]; then
    [[ -n "$fields" ]] && fields="$fields, "
    fields="${fields}\"window_weekly_pct\": ${RALPH_USAGE_WEEKLY_PCT}"
  fi
  if [[ -n "${RALPH_USAGE_WEEKLY_RESET_AT:-}" ]]; then
    fields="$fields, \"weekly_reset_at\": \"${RALPH_USAGE_WEEKLY_RESET_AT}\""
  fi
  printf '{%s}\n' "$fields"
  exit 0
fi

# 2) The cache file a queryer of yours maintains.
cache="${RALPH_USAGE_PROVIDER_CACHE:-$repo/.ralph/usage-provider-$pool.json}"
if [[ -f "$cache" ]]; then
  cat "$cache"
  exit 0
fi

# 3) Nothing to report — fail OPEN rather than inventing a percentage.
echo "usage_provider: no usage numbers for pool '$pool' (no RALPH_USAGE_*_PCT and no $cache)" >&2
exit 3
