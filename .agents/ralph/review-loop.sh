#!/usr/bin/env bash
# Ralph review-loop — adversarial builder/reviewer loop against a SEPARATE target repo.
#
# This script is the orchestrator half of the harness. It runs agent commands
# with their working directory set to a git worktree of the TARGET repo (never
# the harness repo). It never merges to the target's main branch.
#
# Inputs come from environment variables (set by `bin/ralph` or directly):
#   TARGET_REPO        Absolute path to the target git repo (required).
#   BUILDER            Backend name for the builder role (default: opencode).
#   REVIEWER           Backend name for the reviewer role (default: claude).
#   MAX_ITERATIONS     Max builder/reviewer cycles (default: 5).
#   CHECK_CMD          Check command run inside the target (default: ./scripts/check.sh).
#   PRD_PATH           Path to a PRD JSON in the target (auto-discovered if unset).
#   TASK_ID            Select a story by id (optional).
#   TASK_INDEX         1-based index into actionable open stories (optional).
#   ALLOW_DIRTY        "true" to allow a dirty target working tree (default: false).
#   USE_WORKTREE       "false" to branch in place instead of a worktree (default: true).
#   BRANCH             Override the working branch name (optional).
#   VERDICT_REGEX      Regex the reviewer's verdict line must match.
#   BUILDER_PROMPT     Builder prompt template path.
#   REVIEWER_PROMPT    Reviewer prompt template path.
#   RALPH_WORKTREE_DIR Base dir for worktrees (default: <target-parent>/.ralph-worktrees).
#   RALPH_DRY_RUN=1    Skip real agent/check execution (for tests).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pull in backend definitions + resolve_backend_cmd.
if [[ -f "$SCRIPT_DIR/agents.sh" ]]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/agents.sh"
fi
# Optional config overrides (may redefine AGENT_*_CMD, defaults, etc).
if [[ -f "$SCRIPT_DIR/config.sh" ]]; then
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/config.sh"
fi
if [[ -f "$SCRIPT_DIR/review-config.sh" ]]; then
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/review-config.sh"
fi

die() { echo "ralph: $*" >&2; exit 1; }

# ---- Resolve inputs ---------------------------------------------------------
TARGET_REPO="${TARGET_REPO:-}"
[[ -n "$TARGET_REPO" ]] || die "TARGET_REPO is required (use --repo)."
[[ -d "$TARGET_REPO" ]] || die "Target repo not found: $TARGET_REPO"
TARGET_REPO="$(cd "$TARGET_REPO" && pwd)"
git -C "$TARGET_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "Not a git repository: $TARGET_REPO"

BUILDER="${BUILDER:-opencode}"
REVIEWER="${REVIEWER:-claude}"
MAX_ITERATIONS="${MAX_ITERATIONS:-5}"
CHECK_CMD="${CHECK_CMD:-./scripts/check.sh}"
ALLOW_DIRTY="${ALLOW_DIRTY:-false}"
USE_WORKTREE="${USE_WORKTREE:-true}"
VERDICT_REGEX="${VERDICT_REGEX:-^VERDICT: (PASS|FAIL)}"
BUILDER_PROMPT="${BUILDER_PROMPT:-$SCRIPT_DIR/PROMPT_builder.md}"
REVIEWER_PROMPT="${REVIEWER_PROMPT:-$SCRIPT_DIR/PROMPT_reviewer.md}"
DRY_RUN="${RALPH_DRY_RUN:-}"

BUILDER_CMD="$(resolve_backend_cmd "$BUILDER")"
REVIEWER_CMD="$(resolve_backend_cmd "$REVIEWER")"
[[ -n "$BUILDER_CMD" ]] || die "Unknown builder backend: $BUILDER"
[[ -n "$REVIEWER_CMD" ]] || die "Unknown reviewer backend: $REVIEWER"

[[ -f "$BUILDER_PROMPT" ]] || die "Builder prompt not found: $BUILDER_PROMPT"
[[ -f "$REVIEWER_PROMPT" ]] || die "Reviewer prompt not found: $REVIEWER_PROMPT"

# ---- Discover PRD -----------------------------------------------------------
if [[ -z "${PRD_PATH:-}" ]]; then
  if [[ -d "$TARGET_REPO/.agents/tasks" ]]; then
    # First *.json under .agents/tasks
    while IFS= read -r f; do PRD_PATH="$f"; break; done < <(find "$TARGET_REPO/.agents/tasks" -maxdepth 1 -name '*.json' | sort)
  fi
fi
[[ -n "${PRD_PATH:-}" && -f "$PRD_PATH" ]] || die "No PRD JSON found. Pass --prd <path> or add .agents/tasks/*.json in the target."

# ---- Require backends exist -------------------------------------------------
require_backend() {
  local label="$1" cmd="$2" bin
  bin="${cmd%% *}"
  [[ -n "$bin" ]] || die "$label backend command is empty."
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v "$bin" >/dev/null 2>&1 || die "$label backend not found on PATH: $bin"
  fi
}
require_backend "builder ($BUILDER)" "$BUILDER_CMD"
require_backend "reviewer ($REVIEWER)" "$REVIEWER_CMD"

# ---- Dirty check (ignore harness bookkeeping under .ralph/) -----------------
if [[ "$ALLOW_DIRTY" != "true" ]]; then
  DIRTY="$(git -C "$TARGET_REPO" status --porcelain | grep -v -E '(^.. |^)\.ralph/' || true)"
  if [[ -n "$DIRTY" ]]; then
    die "Target repo has uncommitted changes. Commit/stash them or pass --allow-dirty.
$DIRTY"
  fi
fi

# ---- Select the story -------------------------------------------------------
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
RUN_DIR="$TARGET_REPO/.ralph/runs/$RUN_ID"
mkdir -p "$RUN_DIR"

STORY_META="$RUN_DIR/story.meta.json"
STORY_BLOCK="$RUN_DIR/task.md"
python3 - "$PRD_PATH" "$STORY_META" "$STORY_BLOCK" "${TASK_ID:-}" "${TASK_INDEX:-}" <<'PY'
import json, sys
from pathlib import Path

prd_path, meta_out, block_out, task_id, task_index = sys.argv[1:6]
data = json.loads(Path(prd_path).read_text())
stories = data.get("stories") if isinstance(data, dict) else None
if not isinstance(stories, list) or not stories:
    Path(meta_out).write_text(json.dumps({"ok": False, "error": "No stories in PRD"}) + "\n")
    Path(block_out).write_text("")
    sys.exit(0)

def status(s): return str((s or {}).get("status") or "open").strip().lower()
index = {s.get("id"): s for s in stories if isinstance(s, dict)}
def done(sid):
    t = index.get(sid)
    return isinstance(t, dict) and status(t) == "done"

actionable = [
    s for s in stories
    if isinstance(s, dict) and status(s) == "open"
    and all(done(d) for d in (s.get("dependsOn") or []))
]

chosen = None
if task_id:
    chosen = index.get(task_id)
elif task_index:
    try:
        i = int(task_index)
        if 1 <= i <= len(actionable):
            chosen = actionable[i - 1]
    except ValueError:
        pass
else:
    chosen = actionable[0] if actionable else None

if not isinstance(chosen, dict):
    Path(meta_out).write_text(json.dumps({"ok": False, "error": "No actionable story selected"}) + "\n")
    Path(block_out).write_text("")
    sys.exit(0)

acceptance = chosen.get("acceptanceCriteria") or []
desc = chosen.get("description") or ""
gates = data.get("qualityGates") or []
lines = [
    f"### {chosen.get('id','')}: {chosen.get('title','')}",
    f"Status: {chosen.get('status','open')}",
    "",
    "Description:",
    desc if desc else "(none)",
    "",
    "Acceptance Criteria:",
]
lines += [f"- [ ] {a}" for a in acceptance] if acceptance else ["- (none)"]
if gates:
    lines += ["", "Global Quality Gates:"] + [f"- {g}" for g in gates]
Path(block_out).write_text("\n".join(lines).rstrip() + "\n")
Path(meta_out).write_text(json.dumps({
    "ok": True,
    "id": chosen.get("id", ""),
    "title": chosen.get("title", ""),
}) + "\n")
PY

STORY_OK="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("ok"))' "$STORY_META")"
if [[ "$STORY_OK" != "True" ]]; then
  ERR="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("error",""))' "$STORY_META")"
  die "Could not select a story: $ERR"
fi
STORY_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("id",""))' "$STORY_META")"
STORY_TITLE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("title",""))' "$STORY_META")"

# ---- Branch / worktree isolation -------------------------------------------
SAFE_STORY="$(printf '%s' "${STORY_ID:-task}" | tr -c 'A-Za-z0-9._-' '-')"
BRANCH="${BRANCH:-ralph/${SAFE_STORY}-${RUN_ID}}"
BASE_REF="$(git -C "$TARGET_REPO" rev-parse HEAD)"
WORKDIR="$TARGET_REPO"
WORKTREE_PATH=""

if [[ "$USE_WORKTREE" == "true" ]]; then
  WT_BASE="${RALPH_WORKTREE_DIR:-$(dirname "$TARGET_REPO")/.ralph-worktrees}"
  mkdir -p "$WT_BASE"
  WORKTREE_PATH="$WT_BASE/$(basename "$TARGET_REPO")-$RUN_ID"
  echo "Creating worktree: $WORKTREE_PATH (branch $BRANCH)"
  git -C "$TARGET_REPO" worktree add -b "$BRANCH" "$WORKTREE_PATH" \
    || die "Failed to create worktree."
  WORKDIR="$WORKTREE_PATH"
else
  echo "Creating in-place branch: $BRANCH"
  git -C "$TARGET_REPO" checkout -b "$BRANCH" || die "Failed to create branch $BRANCH."
  WORKDIR="$TARGET_REPO"
fi

# Agents guide path inside the working tree (informational).
AGENTS_PATH="(none)"
for f in AGENTS.md CLAUDE.md; do
  if [[ -f "$WORKDIR/$f" ]]; then AGENTS_PATH="$WORKDIR/$f"; break; fi
done

# ---- Helpers ----------------------------------------------------------------
render_prompt() {
  # render_prompt <template> <dst> <iteration> <prev_review_file> <prev_check_file> \
  #               <handoff_file> <git_diff_file> <check_output_file> <check_status>
  python3 - "$@" <<'PY'
import sys
from pathlib import Path
import os

(tmpl, dst, iteration, prev_review, prev_check,
 handoff_file, git_diff_file, check_out_file, check_status) = sys.argv[1:10]

def read(p, fallback="none"):
    if p and Path(p).exists():
        t = Path(p).read_text()
        return t if t.strip() else fallback
    return fallback

env = os.environ
repl = {
    "TARGET_REPO": env.get("WORKDIR", ""),
    "BRANCH": env.get("BRANCH", ""),
    "ITERATION": iteration,
    "MAX_ITERATIONS": env.get("MAX_ITERATIONS", ""),
    "CHECK_CMD": env.get("CHECK_CMD", ""),
    "HANDOFF_PATH": env.get("HANDOFF_PATH", ""),
    "RUN_DIR": env.get("RUN_DIR", ""),
    "AGENTS_PATH": env.get("AGENTS_PATH", ""),
    "STORY_ID": env.get("STORY_ID", ""),
    "STORY_TITLE": env.get("STORY_TITLE", ""),
    "STORY_BLOCK": read(env.get("STORY_BLOCK", ""), ""),
    "PREVIOUS_REVIEW": read(prev_review),
    "PREVIOUS_CHECK": read(prev_check),
    "GIT_DIFF": read(git_diff_file, "(no changes)"),
    "CHECK_OUTPUT": read(check_out_file, "(no output)"),
    "HANDOFF": read(handoff_file, "(handoff not written yet)"),
    "CHECK_STATUS": check_status,
    "VERDICT_REGEX": env.get("VERDICT_REGEX", ""),
}
src = Path(tmpl).read_text()
for k, v in repl.items():
    src = src.replace("{{" + k + "}}", v)
Path(dst).write_text(src)
PY
}

run_backend() {
  # run_backend <command_template> <prompt_file> <logfile>
  local cmd_tmpl="$1" prompt_file="$2" logfile="$3" status
  (
    cd "$WORKDIR" || exit 97
    if [[ "$cmd_tmpl" == *"{prompt}"* ]]; then
      local esc; esc=$(printf '%q' "$prompt_file")
      eval "${cmd_tmpl//\{prompt\}/$esc}"
    else
      eval "$cmd_tmpl" < "$prompt_file"
    fi
  ) 2>&1 | tee "$logfile"
  status=${PIPESTATUS[0]}
  return "$status"
}

cleanup_note() {
  cat <<EOF

To inspect the result:
  cd "$WORKDIR"
  git -C "$WORKDIR" log --oneline "$BASE_REF"..HEAD
  git -C "$WORKDIR" diff "$BASE_REF"

Branch: $BRANCH (NOT merged)
EOF
  if [[ -n "$WORKTREE_PATH" ]]; then
    cat <<EOF
Worktree: $WORKTREE_PATH
When finished, remove it with:
  git -C "$TARGET_REPO" worktree remove "$WORKTREE_PATH"
EOF
  fi
}

write_final_status() {
  local outcome="$1" iters="$2"
  {
    echo "# Final Status: $outcome"
    echo ""
    echo "- Run ID: $RUN_ID"
    echo "- Target repo: $TARGET_REPO"
    echo "- Work dir: $WORKDIR"
    echo "- Branch: $BRANCH (not merged)"
    [[ -n "$WORKTREE_PATH" ]] && echo "- Worktree: $WORKTREE_PATH"
    echo "- Base ref: $BASE_REF"
    echo "- Story: ${STORY_ID:-?}: ${STORY_TITLE:-}"
    echo "- Builder backend: $BUILDER"
    echo "- Reviewer backend: $REVIEWER"
    echo "- Iterations run: $iters of $MAX_ITERATIONS"
    echo "- Check command: $CHECK_CMD"
    echo ""
    echo "Artifacts: $RUN_DIR"
  } > "$RUN_DIR/final_status.md"
}

# Export for the python renderer.
export WORKDIR BRANCH MAX_ITERATIONS CHECK_CMD RUN_DIR AGENTS_PATH \
       STORY_ID STORY_TITLE STORY_BLOCK VERDICT_REGEX

# Persist a resolved-config snapshot.
{
  echo "RUN_ID=$RUN_ID"
  echo "TARGET_REPO=$TARGET_REPO"
  echo "WORKDIR=$WORKDIR"
  echo "BRANCH=$BRANCH"
  echo "BASE_REF=$BASE_REF"
  echo "PRD_PATH=$PRD_PATH"
  echo "STORY_ID=$STORY_ID"
  echo "BUILDER=$BUILDER  CMD=$BUILDER_CMD"
  echo "REVIEWER=$REVIEWER  CMD=$REVIEWER_CMD"
  echo "MAX_ITERATIONS=$MAX_ITERATIONS"
  echo "CHECK_CMD=$CHECK_CMD"
  echo "USE_WORKTREE=$USE_WORKTREE"
  echo "ALLOW_DIRTY=$ALLOW_DIRTY"
  echo "VERDICT_REGEX=$VERDICT_REGEX"
} > "$RUN_DIR/config.resolved.env"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Ralph review loop"
echo "  target=$TARGET_REPO"
echo "  story=${STORY_ID}: ${STORY_TITLE}"
echo "  builder=$BUILDER  reviewer=$REVIEWER  max=$MAX_ITERATIONS"
echo "  artifacts=$RUN_DIR"
echo "═══════════════════════════════════════════════════════"

PREV_REVIEW=""
PREV_CHECK=""
OUTCOME="FAILED_MAX_ITERATIONS"
ITERS_RUN=0

for i in $(seq 1 "$MAX_ITERATIONS"); do
  ITERS_RUN="$i"
  echo ""
  echo "── Iteration $i of $MAX_ITERATIONS ──────────────────────"

  HANDOFF_PATH="$WORKDIR/.agent-handoff.md"
  export HANDOFF_PATH

  BUILDER_PROMPT_R="$RUN_DIR/builder_prompt_$i.md"
  BUILDER_LOG="$RUN_DIR/builder_output_$i.log"
  CHECK_LOG="$RUN_DIR/check_$i.log"
  DIFF_PATCH="$RUN_DIR/diff_$i.patch"
  HANDOFF_SNAP="$RUN_DIR/handoff_$i.md"
  REVIEWER_PROMPT_R="$RUN_DIR/reviewer_prompt_$i.md"
  REVIEWER_OUT="$RUN_DIR/reviewer_output_$i.md"

  # 1. Builder
  render_prompt "$BUILDER_PROMPT" "$BUILDER_PROMPT_R" "$i" "$PREV_REVIEW" "$PREV_CHECK" "" "" "" ""
  echo "Running builder ($BUILDER)..."
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[RALPH_DRY_RUN] builder skipped." | tee "$BUILDER_LOG" >/dev/null
    # Simulate a change + handoff so artifacts exist.
    echo "ralph dry-run iteration $i" >> "$WORKDIR/.ralph-dry-run.txt"
    printf '# Agent Handoff (dry run) iter %s\n' "$i" > "$HANDOFF_PATH"
  else
    set +e
    run_backend "$BUILDER_CMD" "$BUILDER_PROMPT_R" "$BUILDER_LOG"
    set -e
  fi

  # 2. Check command (run inside the work dir)
  echo "Running check ($CHECK_CMD)..."
  CHECK_STATUS=0
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[RALPH_DRY_RUN] check skipped (treated as pass)." | tee "$CHECK_LOG" >/dev/null
    CHECK_STATUS=0
  else
    set +e
    ( cd "$WORKDIR" && eval "$CHECK_CMD" ) > "$CHECK_LOG" 2>&1
    CHECK_STATUS=$?
    set -e
  fi
  echo "Check exit status: $CHECK_STATUS"

  # 3. Capture diff vs base
  git -C "$WORKDIR" add -A >/dev/null 2>&1 || true
  git -C "$WORKDIR" diff "$BASE_REF" > "$DIFF_PATCH" 2>/dev/null || \
    git -C "$WORKDIR" diff > "$DIFF_PATCH" 2>/dev/null || true

  # 4. Snapshot handoff
  if [[ -f "$HANDOFF_PATH" ]]; then
    cp "$HANDOFF_PATH" "$HANDOFF_SNAP"
  else
    echo "(builder did not write a handoff this iteration)" > "$HANDOFF_SNAP"
  fi

  # 5. Reviewer
  render_prompt "$REVIEWER_PROMPT" "$REVIEWER_PROMPT_R" "$i" "" "" "$HANDOFF_SNAP" "$DIFF_PATCH" "$CHECK_LOG" "$CHECK_STATUS"
  echo "Running reviewer ($REVIEWER)..."
  if [[ "$DRY_RUN" == "1" ]]; then
    # Deterministic for tests: PASS once the dry-run change exists.
    {
      echo "### Must-fix issues"
      echo "- none (dry run)"
      echo ""
      echo "VERDICT: PASS"
    } | tee "$REVIEWER_OUT" >/dev/null
  else
    set +e
    run_backend "$REVIEWER_CMD" "$REVIEWER_PROMPT_R" "$REVIEWER_OUT"
    set -e
  fi

  # 6. Parse verdict (last matching line wins)
  VERDICT="$(grep -E "$VERDICT_REGEX" "$REVIEWER_OUT" 2>/dev/null | tail -n1 | grep -oE 'PASS|FAIL' | tail -n1 || true)"
  if [[ -z "$VERDICT" ]]; then
    echo "No verdict line found; treating as FAIL."
    VERDICT="FAIL"
  fi
  echo "Reviewer verdict: $VERDICT  (check_status=$CHECK_STATUS)"

  if [[ "$VERDICT" == "PASS" && "$CHECK_STATUS" -eq 0 ]]; then
    OUTCOME="READY_FOR_HUMAN_REVIEW"
    break
  fi

  # Feed reviewer output + check log back into the next builder iteration.
  PREV_REVIEW="$REVIEWER_OUT"
  PREV_CHECK="$CHECK_LOG"
  echo "Verdict FAIL or checks failing — feeding feedback back to builder."
done

write_final_status "$OUTCOME" "$ITERS_RUN"

echo ""
echo "═══════════════════════════════════════════════════════"
if [[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]]; then
  echo "  ✅ READY_FOR_HUMAN_REVIEW (after $ITERS_RUN iteration(s))"
else
  echo "  ❌ FAILED_MAX_ITERATIONS ($MAX_ITERATIONS iterations)"
fi
echo "═══════════════════════════════════════════════════════"
cleanup_note

if [[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]]; then
  exit 0
fi
exit 2
