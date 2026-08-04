#!/usr/bin/env bash
# Target check command for the ralph-harness DOGFOOD self-host.
# Run by `ralph review`/`ralph batch` after the builder, and by `ralph integrate`
# after merging. Exit 0 = pass, non-zero = fail.
#
# The harness's real gate is its hermetic test suite (see package.json "test").
#
# DOGFOOD MODE (#35): this repo self-hosts — its check IS the test suite, and 8 of
# those tests spawn `ralph build/review/batch`. Run nested inside a ralph check
# (preflight or per-task check set RALPH_IN_PREFLIGHT=1), the full suite would spawn
# ralph -> run this check again -> recurse into a fork bomb (and leak the parent's
# orchestration env into the tests). So when nested, run only the non-recursive
# subset (CLI smoke + shell-syntax parse of every script). The FULL suite remains the
# top-level / merge gate (CI and the Manager run `npm test` before accepting).
set -euo pipefail

if [[ "${RALPH_IN_PREFLIGHT:-}" == "1" ]]; then
  echo "check.sh: dogfood mode (nested in a ralph check) — running non-recursive subset (npm run test:dogfood)"
  npm run test:dogfood
else
  npm test
fi
