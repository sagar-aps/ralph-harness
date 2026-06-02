#!/usr/bin/env bash
# Ralph batch-loop — implement MANY PRDs/tasks sequentially in ONE shared worktree.
#
# Unlike review-loop (one worktree per task), batch mode creates a single branch +
# worktree for the whole plan and runs tasks in order on it, so later tasks build on
# earlier ones. It never merges, pushes, or deletes anything — the human reviews the
# branch afterwards.
#
# Per task: builder -> check -> reviewer (read-only) -> record result -> commit.
#
# Inputs (env, set by `bin/ralph`):
#   TARGET_REPO          Absolute path to the target git repo (required).
#   PLAN                 A directory of *.md tasks (sorted) OR a single .md file
#                        split into tasks at its shallowest heading level (required).
#   BUILDER / REVIEWER   Backend names (default builder=opencode, reviewer=claude).
#   CHECK_CMD            Check command (default: target config .check or ./scripts/check.sh).
#   MAX_TASKS            Cap on tasks (<=0 or unset = all).
#   AUTO_APPROVE_BUILDER "true" => builder uses permission-skipping flags (unattended).
#   STOP_ON_FAIL         "true" => stop at the first failing task.
#   ALLOW_DIRTY          "true" => allow a dirty target working tree.
#   BRANCH               Override branch name (default ralph/batch-<timestamp>).
#   RALPH_WORKTREE_DIR   Base dir for the worktree.
#   RALPH_DRY_RUN=1      Skip ONLY the agent backends; check still runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/agents.sh" ]] && { # shellcheck source=/dev/null
  source "$SCRIPT_DIR/agents.sh"; }
[[ -f "$SCRIPT_DIR/config.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/config.sh"; }
[[ -f "$SCRIPT_DIR/review-config.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/review-config.sh"; }

die() { echo "ralph: $*" >&2; exit 1; }

# ---- Resolve inputs ---------------------------------------------------------
TARGET_REPO="${TARGET_REPO:-}"
[[ -n "$TARGET_REPO" ]] || die "TARGET_REPO is required (use --repo)."
[[ -d "$TARGET_REPO" ]] || die "Target repo not found: $TARGET_REPO"
TARGET_REPO="$(cd "$TARGET_REPO" && pwd)"
git -C "$TARGET_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "Not a git repository: $TARGET_REPO"

PLAN="${PLAN:-}"
[[ -n "$PLAN" ]] || die "PLAN is required (use --plan <dir-or-file>)."
[[ -e "$PLAN" ]] || die "Plan not found: $PLAN"
PLAN="$(cd "$(dirname "$PLAN")" && pwd)/$(basename "$PLAN")"

# Target config (check command + optional end-of-batch preview).
cfg_check=""
cfg_prev_enabled=""; cfg_up=""; cfg_down=""; cfg_url=""; cfg_e2e=""; cfg_host=""
if [[ -f "$TARGET_REPO/ralph.target.json" ]]; then
  eval "$(python3 - "$TARGET_REPO/ralph.target.json" <<'PY'
import json, sys, shlex
try: d = json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
p = d.get("preview", {}) if isinstance(d, dict) else {}
def emit(k, v):
    if v is None: v = ""
    if isinstance(v, bool): v = "true" if v else "false"
    print(f"{k}={shlex.quote(str(v))}")
emit("cfg_check", d.get("check"))
emit("cfg_prev_enabled", p.get("enabled"))
emit("cfg_up", p.get("up"))
emit("cfg_down", p.get("down"))
emit("cfg_url", p.get("url"))
emit("cfg_e2e", p.get("e2e"))
emit("cfg_host", p.get("host"))
PY
)"
fi

BUILDER="${BUILDER:-opencode}"
REVIEWER="${REVIEWER:-claude}"
CHECK_CMD="${CHECK_CMD:-${cfg_check:-./scripts/check.sh}}"
MAX_TASKS="${MAX_TASKS:-0}"
MAX_ITERATIONS="${MAX_ITERATIONS:-5}"   # per-task builder/reviewer retries
AUTO_APPROVE_BUILDER="${AUTO_APPROVE_BUILDER:-false}"
STOP_ON_FAIL="${STOP_ON_FAIL:-false}"
ALLOW_DIRTY="${ALLOW_DIRTY:-false}"
VERDICT_REGEX="${VERDICT_REGEX:-^VERDICT: (PASS|FAIL)}"
BUILDER_PROMPT="${BATCH_BUILDER_PROMPT:-$SCRIPT_DIR/PROMPT_batch_builder.md}"
REVIEWER_PROMPT="${BATCH_REVIEWER_PROMPT:-$SCRIPT_DIR/PROMPT_batch_reviewer.md}"
DRY_RUN="${RALPH_DRY_RUN:-}"

# Optional end-of-batch website preview (brought up ONCE after all tasks, so the
# human can review the whole batch via a URL — same scripts as `ralph review`).
PREVIEW_ENABLED="${PREVIEW_ENABLED:-${cfg_prev_enabled:-false}}"
PREVIEW_UP="${PREVIEW_UP:-${cfg_up:-./scripts/preview-up.sh}}"
PREVIEW_DOWN="${PREVIEW_DOWN:-${cfg_down:-./scripts/preview-down.sh}}"
PREVIEW_URL_CMD="${PREVIEW_URL_CMD:-${cfg_url:-./scripts/preview-url.sh}}"
E2E_CMD="${E2E_CMD:-${cfg_e2e:-./scripts/e2e.sh}}"
PREVIEW_HOST="${PREVIEW_HOST:-${cfg_host:-localhost}}"

# ---- Builder/reviewer command resolution -----------------------------------
strip_autoapprove() {
  # Remove known permission-skipping tokens so a command runs in "manual" mode.
  sed -E 's/ --dangerously-skip-permissions//g; s/ --skip-permissions-unsafe//g; s/ --yolo//g'
}
builder_cmd_for() {
  local base; base="$(resolve_backend_cmd "$1")"
  if [[ "$AUTO_APPROVE_BUILDER" == "true" ]]; then
    printf '%s' "$base"                 # defaults already include skip flags
  else
    printf '%s' "$base" | strip_autoapprove
  fi
}
reviewer_cmd_for() {
  # Reviewer is ALWAYS read-only: sandboxed for codex; never gets skip flags.
  local base
  case "$1" in
    codex) base="${AGENT_CODEX_READONLY_CMD}" ;;
    *)     base="$(resolve_backend_cmd "$1")" ;;
  esac
  printf '%s' "$base" | strip_autoapprove
}

BUILDER_CMD="$(builder_cmd_for "$BUILDER")"
REVIEWER_CMD="$(reviewer_cmd_for "$REVIEWER")"
[[ -n "$BUILDER_CMD" ]] || die "Unknown builder backend: $BUILDER"
[[ -n "$REVIEWER_CMD" ]] || die "Unknown reviewer backend: $REVIEWER"
[[ -f "$BUILDER_PROMPT" ]] || die "Batch builder prompt not found: $BUILDER_PROMPT"
[[ -f "$REVIEWER_PROMPT" ]] || die "Batch reviewer prompt not found: $REVIEWER_PROMPT"

require_backend() {
  local label="$1" cmd="$2" bin; bin="${cmd%% *}"
  [[ -n "$bin" ]] || die "$label backend command is empty."
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v "$bin" >/dev/null 2>&1 || die "$label backend not found on PATH: $bin"
  fi
}
require_backend "builder ($BUILDER)" "$BUILDER_CMD"
require_backend "reviewer ($REVIEWER)" "$REVIEWER_CMD"

# ---- Dirty check (ignore harness bookkeeping) ------------------------------
if [[ "$ALLOW_DIRTY" != "true" ]]; then
  DIRTY="$(git -C "$TARGET_REPO" status --porcelain | grep -v -E '(^.. |^)(\.ralph/|\.agent-run/)' || true)"
  if [[ -n "$DIRTY" ]]; then
    die "Target repo has uncommitted changes. Commit/stash them or pass --allow-dirty.
$DIRTY"
  fi
fi

# ---- Run dir ---------------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)-$$"
BRANCH="${BRANCH:-ralph/batch-$TS}"
RUN_DIR="$TARGET_REPO/.agent-run/batch-$TS"
TASKS_DIR="$RUN_DIR/tasks"
mkdir -p "$TASKS_DIR"

# ---- Preflight (repo contract) — block before any worktree/agent ------------
if ! bash "$SCRIPT_DIR/preflight.sh" "$TARGET_REPO" "$RUN_DIR/preflight.md"; then
  mkdir -p "$TARGET_REPO/.ralph"
  {
    echo "RUN_ID=batch-$TS"; echo "STATUS=PREFLIGHT_FAILED"; echo "BRANCH="
    echo "WORKTREE="; echo "BASE_COMMIT=$(git -C "$TARGET_REPO" rev-parse HEAD 2>/dev/null)"
    echo "PREVIEW_URL="; echo "ARTIFACTS_DIR=$RUN_DIR"; echo "TARGET_REPO=$TARGET_REPO"
  } > "$TARGET_REPO/.ralph/last-run.env"
  echo "Preflight failed — repo baseline is not healthy. No worktree created, no agents run."
  echo "See $RUN_DIR/preflight.md and fix the repo contract first."
  exit 3
fi

# ---- Task discovery --------------------------------------------------------
MANIFEST="$TASKS_DIR/manifest.tsv"
python3 - "$PLAN" "$TASKS_DIR" "$MANIFEST" <<'PY'
import os, re, sys
from pathlib import Path

plan, outdir, manifest = sys.argv[1:4]
tasks = []  # (title, content)

def title_of(text, fallback):
    for line in text.splitlines():
        m = re.match(r'^#{1,6}\s+(.*)$', line)
        if m:
            return m.group(1).strip()
    return fallback

p = Path(plan)
if p.is_dir():
    files = sorted([f for f in p.iterdir() if f.suffix.lower() in (".md", ".markdown", ".txt")])
    for f in files:
        text = f.read_text()
        tasks.append((title_of(text, f.stem), text))
else:
    text = p.read_text()
    lines = text.splitlines(keepends=True)
    heads = []
    for i, l in enumerate(lines):
        m = re.match(r'^(#{1,6})\s+', l)
        if m:
            heads.append((i, len(m.group(1))))
    if not heads:
        tasks.append((title_of(text, p.stem), text))
    else:
        minlvl = min(lvl for _, lvl in heads)
        idxs = [i for i, lvl in heads if lvl == minlvl]
        for k, start in enumerate(idxs):
            end = idxs[k + 1] if k + 1 < len(idxs) else len(lines)
            chunk = "".join(lines[start:end])
            title = re.sub(r'^#{1,6}\s+', '', lines[start]).strip()
            tasks.append((title or f"Task {k+1}", chunk))

with open(manifest, "w") as mf:
    for i, (title, content) in enumerate(tasks, 1):
        fn = f"task-{i:03d}.md"
        (Path(outdir) / fn).write_text(content)
        # tab-separated: index, title, filename
        mf.write(f"{i:03d}\t{title}\t{fn}\n")
print(len(tasks))
PY

TASK_TOTAL="$(wc -l < "$MANIFEST" | tr -d ' ')"
[[ "$TASK_TOTAL" -gt 0 ]] || die "No tasks discovered in plan: $PLAN"
if [[ "$MAX_TASKS" -gt 0 && "$TASK_TOTAL" -gt "$MAX_TASKS" ]]; then
  TASK_RUN_COUNT="$MAX_TASKS"
else
  TASK_RUN_COUNT="$TASK_TOTAL"
fi

# ---- Shared worktree (created ONCE) ----------------------------------------
BASE_REF="$(git -C "$TARGET_REPO" rev-parse HEAD)"
WT_BASE="${RALPH_WORKTREE_DIR:-$(dirname "$TARGET_REPO")/.ralph-worktrees}"
mkdir -p "$WT_BASE"
WORKDIR="$WT_BASE/$(basename "$TARGET_REPO")-batch-$TS"
git -C "$TARGET_REPO" worktree add -b "$BRANCH" "$WORKDIR" >/dev/null \
  || die "Failed to create worktree."

AGENTS_PATH="(none)"
for f in AGENTS.md CLAUDE.md; do
  [[ -f "$WORKDIR/$f" ]] && { AGENTS_PATH="$WORKDIR/$f"; break; }
done

# Dynamic run environment (ports/compose project) for the end-of-batch preview.
find_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}
if [[ "$PREVIEW_ENABLED" == "true" ]]; then
  RALPH_APP_PORT="${RALPH_APP_PORT:-$(find_free_port)}"
  RALPH_DB_PORT="${RALPH_DB_PORT:-$(find_free_port)}"
else
  RALPH_APP_PORT="${RALPH_APP_PORT:-}"; RALPH_DB_PORT="${RALPH_DB_PORT:-}"
fi
RALPH_COMPOSE_PROJECT="ralph-batch-$(printf '%s' "$TS" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '-')"
if [[ -n "$RALPH_APP_PORT" ]]; then
  RALPH_PREVIEW_URL="${RALPH_PREVIEW_URL:-http://$PREVIEW_HOST:$RALPH_APP_PORT}"
else
  RALPH_PREVIEW_URL="${RALPH_PREVIEW_URL:-}"
fi
export RALPH_RUN_ID="batch-$TS" RALPH_TARGET_REPO="$TARGET_REPO" RALPH_WORKTREE="$WORKDIR" \
       RALPH_BRANCH="$BRANCH" RALPH_BASE_COMMIT="$BASE_REF" \
       RALPH_APP_PORT RALPH_DB_PORT RALPH_PREVIEW_URL RALPH_COMPOSE_PROJECT

export WORKDIR BRANCH CHECK_CMD RUN_DIR AGENTS_PATH VERDICT_REGEX \
       TARGET_REPO TASK_TOTAL AUTO_APPROVE_BUILDER MAX_ITERATIONS

# ---- Helpers ----------------------------------------------------------------
render_prompt() {
  python3 - "$1" "$2" <<'PY'
import os, sys
from pathlib import Path
tmpl, dst = sys.argv[1:3]
env = os.environ
def fc(var, fb):
    p = env.get(var, "")
    if p and Path(p).exists():
        t = Path(p).read_text()
        return t if t.strip() else fb
    return fb
repl = {
    "TARGET_REPO": env.get("WORKDIR", ""),
    "BRANCH": env.get("BRANCH", ""),
    "TASK_NUMBER": env.get("R_TASK_NUM", ""),
    "TASK_TOTAL": env.get("TASK_TOTAL", ""),
    "TASK_TITLE": env.get("R_TASK_TITLE", ""),
    "TASK_CONTENT": fc("R_TASK_FILE", "(empty task)"),
    "ACCUMULATED_CONTEXT": fc("R_CONTEXT_FILE", "(this is the first task)"),
    "CHECK_CMD": env.get("CHECK_CMD", ""),
    "CHECK_STATUS": env.get("R_CHECK_STATUS", ""),
    "HANDOFF_PATH": env.get("HANDOFF_PATH", ""),
    "AGENTS_PATH": env.get("AGENTS_PATH", ""),
    "GIT_DIFF": fc("R_DIFF_FILE", "(no changes)"),
    "CHECK_OUTPUT": fc("R_CHECK_FILE", "(no output)"),
    "HANDOFF": fc("R_HANDOFF_FILE", "(handoff not written)"),
    "AUTO_APPROVE": env.get("AUTO_APPROVE_BUILDER", ""),
    "VERDICT_REGEX": env.get("VERDICT_REGEX", ""),
    "ATTEMPT": env.get("R_ITER", ""),
    "MAX_ITERATIONS": env.get("MAX_ITERATIONS", ""),
    "PREVIOUS_REVIEW": fc("R_PREV_REVIEW_FILE", "none (first attempt)"),
    "PREVIOUS_CHECK": fc("R_PREV_CHECK_FILE", "none (first attempt)"),
}
src = Path(tmpl).read_text()
for k, v in repl.items():
    src = src.replace("{{" + k + "}}", v or "")
Path(dst).write_text(src)
PY
}

run_backend() {
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

# ---- Config snapshot + banner ----------------------------------------------
{
  echo "RUN_ID=batch-$TS"
  echo "TARGET_REPO=$TARGET_REPO"
  echo "WORKDIR=$WORKDIR"
  echo "BRANCH=$BRANCH"
  echo "BASE_REF=$BASE_REF"
  echo "PLAN=$PLAN"
  echo "BUILDER=$BUILDER"
  echo "REVIEWER=$REVIEWER"
  echo "BUILDER_CMD=$BUILDER_CMD"
  echo "REVIEWER_CMD=$REVIEWER_CMD"
  echo "CHECK_CMD=$CHECK_CMD"
  echo "AUTO_APPROVE_BUILDER=$AUTO_APPROVE_BUILDER"
  echo "STOP_ON_FAIL=$STOP_ON_FAIL"
  echo "ALLOW_DIRTY=$ALLOW_DIRTY"
  echo "TASK_TOTAL=$TASK_TOTAL"
  echo "TASK_RUN_COUNT=$TASK_RUN_COUNT"
  echo "MAX_ITERATIONS=$MAX_ITERATIONS"
  echo "PREVIEW_ENABLED=$PREVIEW_ENABLED"
  echo "PREVIEW_UP=$PREVIEW_UP"
  echo "PREVIEW_DOWN=$PREVIEW_DOWN"
  echo "PREVIEW_URL_CMD=$PREVIEW_URL_CMD"
  echo "E2E_CMD=$E2E_CMD"
  echo "PREVIEW_HOST=$PREVIEW_HOST"
  echo "RALPH_APP_PORT=$RALPH_APP_PORT"
  echo "RALPH_DB_PORT=$RALPH_DB_PORT"
  echo "RALPH_PREVIEW_URL=$RALPH_PREVIEW_URL"
  echo "RALPH_COMPOSE_PROJECT=$RALPH_COMPOSE_PROJECT"
} > "$RUN_DIR/config.resolved.env"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Ralph BATCH mode (one shared worktree, sequential tasks)"
echo "  target repo:   $TARGET_REPO"
echo "  branch:        $BRANCH"
echo "  worktree:      $WORKDIR"
echo "  plan:          $PLAN"
echo "  tasks:         $TASK_RUN_COUNT of $TASK_TOTAL discovered"
echo "  builder:       $BUILDER   -> $BUILDER_CMD"
echo "  reviewer:      $REVIEWER (read-only) -> $REVIEWER_CMD"
echo "  check:         $CHECK_CMD"
echo "  max attempts/task: $MAX_ITERATIONS   auto-approve builder: $AUTO_APPROVE_BUILDER   stop-on-fail: $STOP_ON_FAIL"
echo "  preview:       $PREVIEW_ENABLED${RALPH_PREVIEW_URL:+  (url after batch: $RALPH_PREVIEW_URL)}"
echo "  artifacts:     $RUN_DIR"
echo "═══════════════════════════════════════════════════════"
if [[ "$AUTO_APPROVE_BUILDER" == "true" ]]; then
  echo "  NOTE: --auto-approve-builder is ON — the BUILDER runs with permission-skipping"
  echo "        flags so it can edit unattended. The REVIEWER stays read-only."
else
  echo "  NOTE: builder runs in MANUAL mode (no permission-skip). For an unattended"
  echo "        overnight batch, pass --auto-approve-builder."
fi

CONTEXT_FILE="$RUN_DIR/batch-context.md"
{
  echo "# Batch accumulated context"
  echo ""
  echo "Branch: $BRANCH  |  Plan: $PLAN  |  Tasks: $TASK_RUN_COUNT of $TASK_TOTAL"
  echo ""
  echo "Completed tasks will be summarized below as the batch proceeds."
  echo ""
} > "$CONTEXT_FILE"

ATTEMPTED=0; COMPLETED=0; FAILED=0
STOPPED_EARLY="false"

# ---- Sequential task loop ---------------------------------------------------
while IFS=$'\t' read -r IDX TITLE FN; do
  [[ -z "$IDX" ]] && continue
  if [[ "$ATTEMPTED" -ge "$TASK_RUN_COUNT" ]]; then break; fi
  ATTEMPTED=$((ATTEMPTED + 1))
  TASK_FILE="$TASKS_DIR/$FN"

  echo ""
  echo "── Task $IDX/$TASK_TOTAL: $TITLE  (up to $MAX_ITERATIONS attempt(s)) ──"

  HANDOFF_PATH="$WORKDIR/.agent-handoff.md"
  RESULT_FILE="$RUN_DIR/task-$IDX-result.md"
  HEAD_BEFORE="$(git -C "$WORKDIR" rev-parse HEAD)"

  # Per-task retry loop: builder -> check -> reviewer, feeding FAIL feedback back
  # to the builder, until check passes AND the reviewer says PASS, or we run out
  # of attempts. Mirrors `ralph review`, but the task is committed once at the end.
  TASK_STATUS="FAIL"; ITERS_USED=0
  PREV_REVIEW=""; PREV_CHECK=""
  # Final-iteration artifacts (the result file points at these).
  DIFF_PATCH="$RUN_DIR/task-$IDX-diff.patch"
  CHECK_LOG="$RUN_DIR/task-$IDX-check.log"
  HANDOFF_SNAP="$RUN_DIR/task-$IDX-handoff.md"
  REVIEWER_OUT="$RUN_DIR/task-$IDX-reviewer.md"

  for ITER in $(seq 1 "$MAX_ITERATIONS"); do
    ITERS_USED="$ITER"
    echo "  • attempt $ITER/$MAX_ITERATIONS"
    BUILDER_PROMPT_R="$RUN_DIR/task-$IDX-iter-$ITER-builder-prompt.md"
    BUILDER_LOG="$RUN_DIR/task-$IDX-iter-$ITER-builder.log"
    ITER_CHECK_LOG="$RUN_DIR/task-$IDX-iter-$ITER-check.log"
    ITER_DIFF="$RUN_DIR/task-$IDX-iter-$ITER-diff.patch"
    ITER_HANDOFF="$RUN_DIR/task-$IDX-iter-$ITER-handoff.md"
    REVIEWER_PROMPT_R="$RUN_DIR/task-$IDX-iter-$ITER-reviewer-prompt.md"
    ITER_REVIEWER_OUT="$RUN_DIR/task-$IDX-iter-$ITER-reviewer.md"

    export R_TASK_NUM="$IDX" R_TASK_TITLE="$TITLE" R_TASK_FILE="$TASK_FILE" \
           R_CONTEXT_FILE="$CONTEXT_FILE" HANDOFF_PATH \
           R_ITER="$ITER" R_PREV_REVIEW_FILE="$PREV_REVIEW" R_PREV_CHECK_FILE="$PREV_CHECK"

    # 1. Builder
    render_prompt "$BUILDER_PROMPT" "$BUILDER_PROMPT_R"
    echo "    builder ($BUILDER)..."
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "[RALPH_DRY_RUN] builder skipped." > "$BUILDER_LOG"
      printf 'batch dry-run task %s iter %s: %s\n' "$IDX" "$ITER" "$TITLE" >> "$WORKDIR/batch-dry-run.txt"
      printf '# Handoff (dry run) task %s iter %s\n- simulated change\n' "$IDX" "$ITER" > "$HANDOFF_PATH"
    else
      set +e; run_backend "$BUILDER_CMD" "$BUILDER_PROMPT_R" "$BUILDER_LOG"; set -e
    fi

    # 2. Check
    echo "    check ($CHECK_CMD)..."
    set +e; ( cd "$WORKDIR" && eval "$CHECK_CMD" ) > "$ITER_CHECK_LOG" 2>&1; CHECK_STATUS=$?; set -e
    echo "    check exit: $CHECK_STATUS"

    # 3. Diff for this task so far (vs the task's starting commit)
    git -C "$WORKDIR" add -A >/dev/null 2>&1 || true
    git -C "$WORKDIR" diff --cached "$HEAD_BEFORE" > "$ITER_DIFF" 2>/dev/null \
      || git -C "$WORKDIR" diff "$HEAD_BEFORE" > "$ITER_DIFF" 2>/dev/null || true
    CHANGED_FILES="$(git -C "$WORKDIR" diff --cached --name-only "$HEAD_BEFORE" 2>/dev/null || true)"

    # 4. Handoff snapshot
    if [[ -f "$HANDOFF_PATH" ]]; then cp "$HANDOFF_PATH" "$ITER_HANDOFF"
    else echo "(builder did not write a handoff)" > "$ITER_HANDOFF"; fi

    # 5. Reviewer (read-only)
    export R_CHECK_STATUS="$CHECK_STATUS" R_DIFF_FILE="$ITER_DIFF" \
           R_CHECK_FILE="$ITER_CHECK_LOG" R_HANDOFF_FILE="$ITER_HANDOFF"
    render_prompt "$REVIEWER_PROMPT" "$REVIEWER_PROMPT_R"
    echo "    reviewer ($REVIEWER, read-only)..."
    if [[ "$DRY_RUN" == "1" ]]; then
      { echo "### Must-fix issues"; echo "- none (dry run)"; echo ""; echo "VERDICT: PASS"; } > "$ITER_REVIEWER_OUT"
    else
      set +e; run_backend "$REVIEWER_CMD" "$REVIEWER_PROMPT_R" "$ITER_REVIEWER_OUT"; set -e
    fi
    VERDICT="$(grep -E "$VERDICT_REGEX" "$ITER_REVIEWER_OUT" 2>/dev/null | tail -n1 | grep -oE 'PASS|FAIL' | tail -n1 || true)"
    [[ -z "$VERDICT" ]] && VERDICT="FAIL"
    echo "    verdict: $VERDICT (check=$CHECK_STATUS)"

    # Point the canonical per-task artifacts at this (latest) attempt.
    cp "$ITER_CHECK_LOG" "$CHECK_LOG" 2>/dev/null || true
    cp "$ITER_DIFF" "$DIFF_PATCH" 2>/dev/null || true
    cp "$ITER_HANDOFF" "$HANDOFF_SNAP" 2>/dev/null || true
    cp "$ITER_REVIEWER_OUT" "$REVIEWER_OUT" 2>/dev/null || true

    if [[ "$VERDICT" == "PASS" && "$CHECK_STATUS" -eq 0 ]]; then
      TASK_STATUS="PASS"
      break
    fi
    # Feed this attempt's reviewer + check logs back into the next builder attempt.
    PREV_REVIEW="$ITER_REVIEWER_OUT"; PREV_CHECK="$ITER_CHECK_LOG"
    [[ "$ITER" -lt "$MAX_ITERATIONS" ]] && echo "    not passing — retrying with feedback"
  done

  if [[ "$TASK_STATUS" == "PASS" ]]; then COMPLETED=$((COMPLETED + 1))
  else FAILED=$((FAILED + 1)); fi
  echo "Task $IDX result: $TASK_STATUS after $ITERS_USED/$MAX_ITERATIONS attempt(s)"

  # Commit this task's work on the shared branch (kept even if FAIL, so later
  # tasks build on it; clearly labelled).
  if [[ -n "$(git -C "$WORKDIR" status --porcelain)" ]]; then
    git -C "$WORKDIR" add -A >/dev/null 2>&1 || true
    git -C "$WORKDIR" commit -qm "ralph batch task $IDX: $TITLE [$TASK_STATUS]" >/dev/null 2>&1 || true
  fi
  HEAD_AFTER="$(git -C "$WORKDIR" rev-parse HEAD)"

  # Per-task result file
  {
    echo "# Task $IDX — $TITLE"
    echo ""
    echo "- Result: $TASK_STATUS"
    echo "- Attempts: $ITERS_USED of $MAX_ITERATIONS"
    echo "- Check exit: $CHECK_STATUS"
    echo "- Reviewer verdict: $VERDICT"
    echo "- Commit: $HEAD_BEFORE -> $HEAD_AFTER"
    echo ""
    echo "## Files changed"
    if [[ -n "$CHANGED_FILES" ]]; then printf '%s\n' "$CHANGED_FILES" | sed 's/^/- /'; else echo "- (none)"; fi
    echo ""
    echo "## Artifacts (final attempt; per-attempt logs are task-$IDX-iter-N-*)"
    echo "- Check log: $CHECK_LOG"
    echo "- Diff: $DIFF_PATCH"
    echo "- Handoff: $HANDOFF_SNAP"
    echo "- Reviewer: $REVIEWER_OUT"
  } > "$RESULT_FILE"

  # 8. Accumulate context for the next task
  {
    echo "## Task $IDX — $TITLE  [$TASK_STATUS]"
    echo "Files changed:"
    if [[ -n "$CHANGED_FILES" ]]; then printf '%s\n' "$CHANGED_FILES" | sed 's/^/- /'; else echo "- (none)"; fi
    echo ""
    echo "Handoff:"
    sed 's/^/> /' "$HANDOFF_SNAP"
    echo ""
  } >> "$CONTEXT_FILE"

  if [[ "$TASK_STATUS" == "FAIL" && "$STOP_ON_FAIL" == "true" ]]; then
    echo "Task $IDX failed and --stop-on-fail is set. Stopping batch."
    STOPPED_EARLY="true"
    break
  fi
done < "$MANIFEST"

# ---- End-of-batch preview (optional) ---------------------------------------
# Bring the whole branch up ONCE so the human can review the entire batch via a
# URL (same scripts as `ralph review`). Left running for review; `ralph cleanup`
# stops it via the preview-down script.
PREVIEW_RAN="false"; PREVIEW_UP_OK=""; E2E_OK=""
if [[ "$PREVIEW_ENABLED" == "true" ]]; then
  PREVIEW_RAN="true"
  echo ""
  echo "── End-of-batch preview ──────────────────────"
  echo "Running preview-up ($PREVIEW_UP)  [app=$RALPH_APP_PORT db=$RALPH_DB_PORT]..."
  set +e; ( cd "$WORKDIR" && eval "$PREVIEW_UP" ) > "$RUN_DIR/preview-up.log" 2>&1; UP_STATUS=$?; set -e
  if [[ "$UP_STATUS" -ne 0 ]]; then
    PREVIEW_UP_OK="false"
    echo "preview-up FAILED (status=$UP_STATUS). See $RUN_DIR/preview-up.log"
  else
    PREVIEW_UP_OK="true"
    set +e; ( cd "$WORKDIR" && eval "$PREVIEW_URL_CMD" ) > "$RUN_DIR/preview-url.txt" 2>/dev/null; set -e
    URL_FROM_SCRIPT="$(head -n1 "$RUN_DIR/preview-url.txt" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$URL_FROM_SCRIPT" ]]; then RALPH_PREVIEW_URL="$URL_FROM_SCRIPT"
    else printf '%s\n' "$RALPH_PREVIEW_URL" > "$RUN_DIR/preview-url.txt"; fi
    export RALPH_PREVIEW_URL
    echo "Preview URL: $RALPH_PREVIEW_URL"
    echo "Running e2e ($E2E_CMD)..."
    set +e; ( cd "$WORKDIR" && eval "$E2E_CMD" ) > "$RUN_DIR/e2e.log" 2>&1; E2E_STATUS=$?; set -e
    if [[ "$E2E_STATUS" -eq 0 ]]; then E2E_OK="true"
    else E2E_OK="false"; echo "e2e FAILED (status=$E2E_STATUS). See $RUN_DIR/e2e.log"; fi
    echo "Preview left running for review. Stop it with: ralph cleanup --repo \"$TARGET_REPO\""
  fi
fi

# ---- Outcome ----------------------------------------------------------------
if [[ "$STOPPED_EARLY" == "true" ]]; then
  OUTCOME="STOPPED_ON_FAIL"
elif [[ "$FAILED" -gt 0 ]]; then
  OUTCOME="COMPLETED_WITH_FAILURES"
elif [[ "$PREVIEW_RAN" == "true" && ( "$PREVIEW_UP_OK" != "true" || "$E2E_OK" == "false" ) ]]; then
  OUTCOME="COMPLETED_WITH_FAILURES"
else
  OUTCOME="READY_FOR_HUMAN_REVIEW"
fi

REPORT="$RUN_DIR/final-report.md"
{
  echo "# Ralph batch final report — $OUTCOME"
  echo ""
  echo "- Target repo: $TARGET_REPO"
  echo "- Branch (NOT merged): $BRANCH"
  echo "- Worktree: $WORKDIR"
  echo "- Base commit: $BASE_REF"
  echo "- Plan: $PLAN"
  echo "- Builder: $BUILDER  |  Reviewer: $REVIEWER (read-only)"
  echo "- Auto-approve builder: $AUTO_APPROVE_BUILDER  |  Stop-on-fail: $STOP_ON_FAIL"
  echo "- Check command: $CHECK_CMD"
  echo "- Tasks attempted: $ATTEMPTED of $TASK_TOTAL (completed: $COMPLETED, failed: $FAILED)"
  if [[ "$PREVIEW_RAN" == "true" ]]; then
    echo "- Preview: ${PREVIEW_UP_OK:+up=$PREVIEW_UP_OK }${E2E_OK:+e2e=$E2E_OK }URL=$RALPH_PREVIEW_URL"
  else
    echo "- Preview: disabled"
  fi
  echo ""
  echo "## Per-task results"
  echo ""
  echo "| # | Title | Result | Attempts | Check | Verdict | Files |"
  echo "|---|-------|--------|----------|-------|---------|-------|"
  while IFS=$'\t' read -r IDX TITLE FN; do
    [[ -z "$IDX" ]] && continue
    rf="$RUN_DIR/task-$IDX-result.md"
    [[ -f "$rf" ]] || continue
    res="$(grep -m1 '^- Result:' "$rf" | sed 's/^- Result: //')"
    att="$(grep -m1 '^- Attempts:' "$rf" | sed 's/^- Attempts: //')"
    chk="$(grep -m1 '^- Check exit:' "$rf" | sed 's/^- Check exit: //')"
    ver="$(grep -m1 '^- Reviewer verdict:' "$rf" | sed 's/^- Reviewer verdict: //')"
    nfiles="$(awk '/^## Files changed/{f=1;next} /^## /{f=0} f&&/^- /{c++} END{print c+0}' "$rf")"
    echo "| $IDX | $TITLE | $res | $att | $chk | $ver | $nfiles |"
  done < "$MANIFEST"
  echo ""
  echo "## Failures / blockers"
  blockers=0
  while IFS=$'\t' read -r IDX TITLE FN; do
    [[ -z "$IDX" ]] && continue
    rf="$RUN_DIR/task-$IDX-result.md"
    [[ -f "$rf" ]] || continue
    if grep -q '^- Result: FAIL' "$rf"; then
      echo "- Task $IDX ($TITLE): see $RUN_DIR/task-$IDX-reviewer.md and task-$IDX-check.log"
      blockers=$((blockers + 1))
    fi
  done < "$MANIFEST"
  if [[ "$PREVIEW_RAN" == "true" && "$PREVIEW_UP_OK" != "true" ]]; then
    echo "- End-of-batch preview FAILED to start: see $RUN_DIR/preview-up.log"
    blockers=$((blockers + 1))
  elif [[ "$PREVIEW_RAN" == "true" && "$E2E_OK" == "false" ]]; then
    echo "- End-of-batch e2e FAILED against $RALPH_PREVIEW_URL: see $RUN_DIR/e2e.log"
    blockers=$((blockers + 1))
  fi
  [[ "$blockers" -eq 0 ]] && echo "- none"
  echo ""
  echo "## Suggested human review steps"
  if [[ "$PREVIEW_RAN" == "true" && "$PREVIEW_UP_OK" == "true" ]]; then
    echo "1. Open the preview and click through the whole batch: $RALPH_PREVIEW_URL"
    echo "2. Inspect the branch:    git -C \"$WORKDIR\" log --oneline \"$BASE_REF\"..HEAD"
    echo "3. Review the full diff:  git -C \"$WORKDIR\" diff \"$BASE_REF\""
    echo "4. Re-run checks:         ( cd \"$WORKDIR\" && $CHECK_CMD )"
    echo "5. If satisfied, integrate (after review): ralph integrate --repo \"$TARGET_REPO\""
    echo "6. Clean up (stops preview + removes worktree): ralph cleanup --repo \"$TARGET_REPO\""
  else
    echo "1. Inspect the branch:    git -C \"$WORKDIR\" log --oneline \"$BASE_REF\"..HEAD"
    echo "2. Review the full diff:  git -C \"$WORKDIR\" diff \"$BASE_REF\""
    echo "3. Re-run checks:         ( cd \"$WORKDIR\" && $CHECK_CMD )"
    echo "4. If satisfied, integrate (after review): ralph integrate --repo \"$TARGET_REPO\""
    echo "5. Clean up worktree:     ralph cleanup --repo \"$TARGET_REPO\""
  fi
  echo ""
  echo "Nothing was merged, pushed, or deleted. The branch and worktree are intact."
} > "$REPORT"

# Make `ralph status / integrate / cleanup` work on the batch branch too.
mkdir -p "$TARGET_REPO/.ralph"
{
  echo "RUN_ID=batch-$TS"
  echo "STATUS=$OUTCOME"
  echo "BRANCH=$BRANCH"
  echo "WORKTREE=$WORKDIR"
  echo "BASE_COMMIT=$BASE_REF"
  if [[ "$PREVIEW_RAN" == "true" && "$PREVIEW_UP_OK" == "true" ]]; then
    echo "PREVIEW_URL=$RALPH_PREVIEW_URL"
  else
    echo "PREVIEW_URL="
  fi
  echo "ARTIFACTS_DIR=$RUN_DIR"
  echo "TARGET_REPO=$TARGET_REPO"
  echo "RALPH_COMPOSE_PROJECT=$RALPH_COMPOSE_PROJECT"
  echo "RALPH_APP_PORT=$RALPH_APP_PORT"
  echo "RALPH_DB_PORT=$RALPH_DB_PORT"
  echo "USE_WORKTREE=true"
} > "$TARGET_REPO/.ralph/last-run.env"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Batch $OUTCOME"
echo "  attempted=$ATTEMPTED completed=$COMPLETED failed=$FAILED"
echo "───────────────────────────────────────────────────────"
echo "  Branch:    $BRANCH (NOT merged)"
echo "  Worktree:  $WORKDIR"
echo "  Report:    $REPORT"
if [[ "$PREVIEW_RAN" == "true" && "$PREVIEW_UP_OK" == "true" ]]; then
  echo "  Preview:   $RALPH_PREVIEW_URL  (running — open it to review the whole batch)"
elif [[ "$PREVIEW_RAN" == "true" ]]; then
  echo "  Preview:   FAILED to start — see $RUN_DIR/preview-up.log"
fi
echo "  Integrate (after review): ralph integrate --repo \"$TARGET_REPO\""
echo "  Cleanup:   ralph cleanup --repo \"$TARGET_REPO\""
echo "═══════════════════════════════════════════════════════"

[[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]] && exit 0
exit 2
