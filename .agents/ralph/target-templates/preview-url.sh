#!/usr/bin/env bash
# preview-url.sh — print the URL where the running preview can be reached.
# Print ONE line (the URL) to stdout and exit 0. If you print nothing, the harness
# falls back to its computed default (http://<host>:$RALPH_APP_PORT).
set -euo pipefail

# Default: echo the harness-provided URL. Override if your app uses a path/subdomain.
echo "${RALPH_PREVIEW_URL:-http://localhost:${RALPH_APP_PORT:-3000}}"
