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
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Dogfood mode is HARNESS-ONLY. It activates only when BOTH hold:
#   (a) we are nested inside a ralph-invoked check (RALPH_IN_PREFLIGHT=1), AND
#   (b) this really IS the ralph harness repo (package.json identity).
# (b) guarantees no other target can shrink its own check by mistake — even if a repo
# ever copies this script, the identity check fails there and it runs its full check.
if [[ "${RALPH_IN_PREFLIGHT:-}" == "1" ]] && grep -q '"@iannuttall/ralph"' "$ROOT/package.json" 2>/dev/null; then
  echo "check.sh: dogfood mode (ralph-harness self-host, nested check) — non-recursive subset (npm run test:dogfood)"
  npm run test:dogfood
else
  npm test
fi
