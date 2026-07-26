# Floor guard — identity-agnostic mechanical enforcement of the orchestrator's floor.
#
# The orchestrator's floor (never merge/approve a PR, never push the default branch,
# never deploy prod) is otherwise "charter-enforced, not token-enforced": a drifting
# cheap model can do any of them because `gh`/`git` will happily comply. This makes the
# floor mechanical WITHOUT requiring any GitHub App or special identity — it works under
# plain `gh auth`. GitHub Apps + branch protection remain a bonus layer, never a
# precondition (owner directive, issue #6).
#
# HOW: source this at the top of an orchestrator session. It prepends a directory of
# thin `gh`/`git` shims to PATH; the shims refuse the forbidden operations and otherwise
# `exec` the real binary. It is PATH-scoped to this shell, so builders/reviewers running
# in their own processes are unaffected.
#
#     source .agents/ralph/floor-guard.sh        # arms the guard for this shell
#     RALPH_FLOOR_GUARD=off source .agents/ralph/floor-guard.sh   # explicit disable
#
# Config (env, all optional):
#   RALPH_DEFAULT_BRANCH   default branch the guard protects (default: autodetected, else main)
#   RALPH_PROD_DEPLOY_RE   extra regex; a `gh`/`git`… no — a deploy is guarded separately by
#                          the deploy wrapper the target defines. This file guards gh+git only.
#   RALPH_FLOOR_GUARD=off  disable (for debugging; logs a loud warning)

if [ "${RALPH_FLOOR_GUARD:-on}" = "off" ]; then
  echo "floor-guard: DISABLED via RALPH_FLOOR_GUARD=off — the orchestrator floor is NOT enforced." >&2
  return 0 2>/dev/null || exit 0
fi

# Resolve the REAL binaries once, before we shadow them on PATH.
_fg_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export RALPH_REAL_GH="${RALPH_REAL_GH:-$(command -v gh 2>/dev/null || true)}"
export RALPH_REAL_GIT="${RALPH_REAL_GIT:-$(command -v git 2>/dev/null || true)}"

# Detect the default branch if not pinned: origin/HEAD, else current, else main.
if [ -z "${RALPH_DEFAULT_BRANCH:-}" ]; then
  RALPH_DEFAULT_BRANCH="$(
    "${RALPH_REAL_GIT:-git}" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null \
      | sed 's#^origin/##'
  )"
  [ -n "$RALPH_DEFAULT_BRANCH" ] || RALPH_DEFAULT_BRANCH="main"
fi
export RALPH_DEFAULT_BRANCH

export PATH="$_fg_self_dir/floor-guard:$PATH"
echo "floor-guard: armed (protecting '$RALPH_DEFAULT_BRANCH'; refuses pr merge/approve + push to default)." >&2
