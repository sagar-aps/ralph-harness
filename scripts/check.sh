#!/usr/bin/env bash
# Target check command for the ralph-harness DOGFOOD self-host.
# Run by `ralph review`/`ralph batch` after the builder, and by `ralph integrate`
# after merging. Exit 0 = pass, non-zero = fail.
#
# The harness's real gate is its hermetic test suite (see package.json "test").
set -euo pipefail

npm test
