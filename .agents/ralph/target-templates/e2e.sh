#!/usr/bin/env bash
# e2e.sh — run end-to-end / Playwright tests against the running preview.
# Exit 0 = pass, non-zero = fail (failure is fed back to the builder).
#
# The harness exports RALPH_PREVIEW_URL (and RALPH_APP_PORT etc). Point your e2e
# runner at that URL rather than hard-coding localhost:3000.
set -euo pipefail

echo "e2e: target URL = ${RALPH_PREVIEW_URL:-unset}"

# TODO: run your real e2e suite against $RALPH_PREVIEW_URL, e.g.:
#   PLAYWRIGHT_BASE_URL="$RALPH_PREVIEW_URL" npx playwright test

echo "e2e: TEMPLATE ONLY — no tests run. Edit scripts/e2e.sh."
exit 0
