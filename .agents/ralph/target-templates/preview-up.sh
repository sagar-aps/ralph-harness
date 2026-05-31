#!/usr/bin/env bash
# preview-up.sh — start the app preview for this run. Exit 0 on success.
#
# The harness exports (do NOT parse CLI args — read the environment):
#   RALPH_RUN_ID          unique id for this run
#   RALPH_WORKTREE        the checked-out worktree you are running in (cwd)
#   RALPH_APP_PORT        port the app should listen on
#   RALPH_DB_PORT         port the database should listen on
#   RALPH_COMPOSE_PROJECT isolated docker-compose project name (avoids clashes)
#   RALPH_PREVIEW_URL     suggested URL (http://<host>:$RALPH_APP_PORT)
#
# This is a conservative template. Replace the TODO with your real stack, e.g.
# a docker compose project parameterised by the env vars above.
set -euo pipefail

echo "preview-up: run=$RALPH_RUN_ID app_port=${RALPH_APP_PORT:-?} db_port=${RALPH_DB_PORT:-?}"
echo "preview-up: compose_project=${RALPH_COMPOSE_PROJECT:-?}"

# TODO: bring the app up on $RALPH_APP_PORT and the DB on $RALPH_DB_PORT.
# Example (Next.js + Postgres via compose):
#   APP_PORT="$RALPH_APP_PORT" DB_PORT="$RALPH_DB_PORT" \
#   docker compose -p "$RALPH_COMPOSE_PROJECT" up -d --build
#   # then wait for the app to answer on $RALPH_APP_PORT before returning.

echo "preview-up: TEMPLATE ONLY — no real preview started. Edit scripts/preview-up.sh."
exit 0
