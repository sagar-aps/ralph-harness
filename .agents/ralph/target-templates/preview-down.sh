#!/usr/bin/env bash
# preview-down.sh — stop/tear down the preview started by preview-up.sh.
# Receives the same RALPH_* environment. Should be idempotent (safe to run twice).
set -euo pipefail

echo "preview-down: run=${RALPH_RUN_ID:-?} compose_project=${RALPH_COMPOSE_PROJECT:-?}"

# TODO: tear down the preview, e.g.:
#   docker compose -p "$RALPH_COMPOSE_PROJECT" down -v

echo "preview-down: TEMPLATE ONLY — nothing to stop. Edit scripts/preview-down.sh."
exit 0
