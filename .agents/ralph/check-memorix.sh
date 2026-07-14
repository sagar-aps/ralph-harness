#!/usr/bin/env bash
# Ralph per-attempt check for Memorix (the --check gate). Fast; runs every builder
# attempt and again at `ralph integrate`.
#
# Invoked by ralph with cwd = the task WORKTREE (a fresh `git worktree add` off main,
# so web/node_modules is absent). `ralph integrate` reuses this command in the PRIMARY
# checkout, where node_modules already exists (the copy step is a no-op there).
#
# WHY THIS IS A SCRIPT, NOT AN INLINE CHECK_CMD (read this before "simplifying"):
# ralph evals $CHECK_CMD / $VERIFY_CMD via `eval "$CMD"` (batch-loop.sh). A shell
# brace-group `{ ...; }` or `$(...)` in that string gets truncated at the `}`, leaving
# an unterminated group → "syntax error: unexpected end of file" on EVERY attempt — a
# vacuous, code-independent failure that forces retries until MAX_ITERATIONS even when
# the work is correct. A single-token path to this file has no shell metacharacters, so
# it survives eval intact.
#   RULE: keep CHECK_CMD / VERIFY_CMD to ONE command or ONE script path. Never inline
#   `{ }`, `$( )`, or complex quoting. Put complex logic in a script like this one.
#
# WHY cp -al, NOT ln -s, for node_modules: a symlink named `node_modules` is NOT
# matched by a dir-only `node_modules/` gitignore pattern, so the builder's `git add -A`
# stages the absolute-path symlink into the diff. A real DIRECTORY (from cp) is matched
# and ignored. (cp -al shares inodes — fast, no data dup; if a task ever runs
# `npm install` and you must not mutate the primary checkout's deps, switch to `cp -a`.)
set -euo pipefail
cd web
if [ ! -e node_modules ]; then
  cp -al "$HOME/Memorix/Memorix/web/node_modules" node_modules
fi
npm run type-check
