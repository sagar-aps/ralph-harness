#!/usr/bin/env bash
# Target check command — run by `ralph review` after the builder, and again by
# `ralph integrate` after merging. Exit 0 = pass, non-zero = fail.
#
# Replace the body with your real lint/typecheck/unit-test pipeline, e.g.:
#   npm run lint && npm run typecheck && npm test
set -euo pipefail

echo "check.sh: no checks configured yet (edit scripts/check.sh)."
# TODO: add real checks. Until then this passes so the loop can run.
exit 0
