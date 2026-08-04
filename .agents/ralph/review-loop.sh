#!/usr/bin/env bash
# Ralph review-loop — adversarial builder/reviewer loop against a SEPARATE target repo,
# with optional website preview + e2e validation.
#
# This script is the orchestrator half of the harness. It runs agent commands and
# the target's check/preview/e2e scripts with their working directory set to a git
# worktree of the TARGET repo (never the harness repo). It never merges to main.
#
# Per-iteration flow (preview stages are optional):
#   builder -> check -> [preview-up -> preview-url -> e2e] -> reviewer
# PASS requires: check exit 0  AND  (preview disabled OR preview-up+e2e ok)  AND
#                reviewer VERDICT: PASS.
#
# Inputs come from environment variables (set by `bin/ralph` or directly):
#   TARGET_REPO        Absolute path to the target git repo (required).
#   BUILDER            Backend name for the builder role (default: opencode).
#   REVIEWER           Backend name for the reviewer role (default: claude).
#   MAX_ITERATIONS     Max builder/reviewer cycles (default: 5).
#   CHECK_CMD          Check command (default: target config .check or ./scripts/check.sh).
#   PRD_PATH           Path to a PRD JSON in the target (auto-discovered if unset).
#   TASK_ID/TASK_INDEX Select a story by id, or 1-based index into actionable open stories.
#   ALLOW_DIRTY        "true" to allow a dirty target working tree (default: false).
#   USE_WORKTREE       "false" to branch in place instead of a worktree (default: true).
#   BRANCH             Override the working branch name (optional).
#   VERDICT_REGEX      Regex the reviewer's verdict line must match.
#   BUILDER_PROMPT / REVIEWER_PROMPT   Prompt template paths.
#   RALPH_WORKTREE_DIR Base dir for worktrees (default: <target-parent>/.ralph-worktrees).
#   PREVIEW_ENABLED    "true"/"false" to force preview on/off (else target config).
#   PREVIEW_UP/PREVIEW_DOWN/PREVIEW_URL_CMD/E2E_CMD   Override preview scripts.
#   KEEP_ON_PASS/KEEP_ON_FAIL   Keep the preview running after the run (booleans).
#   PREVIEW_HOST       Hostname for the preview URL (default: localhost).
#   RALPH_APP_PORT/RALPH_DB_PORT   Fixed ports (else auto-allocated).
#   RALPH_DRY_RUN=1    Skip ONLY the agent backends; check + preview/e2e still run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pull in backend definitions + resolve_backend_cmd, then optional config overrides.
[[ -f "$SCRIPT_DIR/agents.sh" ]] && { # shellcheck source=/dev/null
  source "$SCRIPT_DIR/agents.sh"; }
[[ -f "$SCRIPT_DIR/config.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/config.sh"; }
[[ -f "$SCRIPT_DIR/review-config.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/review-config.sh"; }
# Untracked local overrides (gitignored) — sourced LAST so they win. Copy
# config.local.sh.example to config.local.sh to define/override backends & roles.
# RALPH_NO_LOCAL_CONFIG=1 skips it — used by the test suite so a developer's machine
# config (e.g. a repo-specific CHECK_CMD) can't leak into hermetic test runs.
[[ "${RALPH_NO_LOCAL_CONFIG:-}" != "1" && -f "$SCRIPT_DIR/config.local.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/config.local.sh"; }

die() { echo "ralph: $*" >&2; exit 1; }

# ---- Resolve inputs ---------------------------------------------------------
TARGET_REPO="${TARGET_REPO:-}"
[[ -n "$TARGET_REPO" ]] || die "TARGET_REPO is required (use --repo)."
[[ -d "$TARGET_REPO" ]] || die "Target repo not found: $TARGET_REPO"
TARGET_REPO="$(cd "$TARGET_REPO" && pwd)"
git -C "$TARGET_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "Not a git repository: $TARGET_REPO"

# ---- Read target config (ralph.target.json) ---------------------------------
# CLI/env values win; config fills gaps; then hardcoded defaults.
TARGET_CONFIG="$TARGET_REPO/ralph.target.json"
cfg_check=""; cfg_prev_enabled=""; cfg_up=""; cfg_down=""; cfg_url=""; cfg_e2e=""
cfg_keep_pass=""; cfg_keep_fail=""; cfg_host=""
if [[ -f "$TARGET_CONFIG" ]]; then
  eval "$(python3 - "$TARGET_CONFIG" <<'PY'
import json, sys, shlex
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit(0)
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
emit("cfg_keep_pass", p.get("keepOnPass"))
emit("cfg_keep_fail", p.get("keepOnFail"))
emit("cfg_host", p.get("host"))
PY
)"
fi

# Normalized agent selection (#4): env/CLI flags > config.local.sh > shipped default.
# (The ralph.target.json "agents" block is honored by `ralph batch`; here env/CLI and
# config.local drive it.) No-op unless a spec/profile is set.
if declare -F ralph_resolve_role_agents >/dev/null 2>&1; then ralph_resolve_role_agents; fi

BUILDER="${BUILDER:-opencode}"
REVIEWER="${REVIEWER:-claude}"
MAX_ITERATIONS="${MAX_ITERATIONS:-5}"
CHECK_CMD="${CHECK_CMD:-${cfg_check:-./scripts/check.sh}}"
ALLOW_DIRTY="${ALLOW_DIRTY:-false}"
USE_WORKTREE="${USE_WORKTREE:-true}"
VERDICT_REGEX="${VERDICT_REGEX:-^VERDICT: (PASS|FAIL)}"
BUILDER_PROMPT="${BUILDER_PROMPT:-$SCRIPT_DIR/PROMPT_builder.md}"
REVIEWER_PROMPT="${REVIEWER_PROMPT:-$SCRIPT_DIR/PROMPT_reviewer.md}"
DRY_RUN="${RALPH_DRY_RUN:-}"

# Preview lifecycle resolution.
PREVIEW_ENABLED="${PREVIEW_ENABLED:-${cfg_prev_enabled:-false}}"
PREVIEW_UP="${PREVIEW_UP:-${cfg_up:-./scripts/preview-up.sh}}"
PREVIEW_DOWN="${PREVIEW_DOWN:-${cfg_down:-./scripts/preview-down.sh}}"
PREVIEW_URL_CMD="${PREVIEW_URL_CMD:-${cfg_url:-./scripts/preview-url.sh}}"
E2E_CMD="${E2E_CMD:-${cfg_e2e:-./scripts/e2e.sh}}"
KEEP_ON_PASS="${KEEP_ON_PASS:-${cfg_keep_pass:-true}}"
KEEP_ON_FAIL="${KEEP_ON_FAIL:-${cfg_keep_fail:-false}}"
PREVIEW_HOST="${PREVIEW_HOST:-${cfg_host:-localhost}}"

BUILDER_CMD="$(resolve_backend_cmd "$BUILDER")"
REVIEWER_CMD="$(resolve_backend_cmd "$REVIEWER")"
[[ -n "$BUILDER_CMD" ]] || die "Unknown builder backend: $BUILDER"
[[ -n "$REVIEWER_CMD" ]] || die "Unknown reviewer backend: $REVIEWER"
[[ -f "$BUILDER_PROMPT" ]] || die "Builder prompt not found: $BUILDER_PROMPT"
[[ -f "$REVIEWER_PROMPT" ]] || die "Reviewer prompt not found: $REVIEWER_PROMPT"

# ---- Discover PRD -----------------------------------------------------------
if [[ -z "${PRD_PATH:-}" && -d "$TARGET_REPO/.agents/tasks" ]]; then
  while IFS= read -r f; do PRD_PATH="$f"; break; done \
    < <(find "$TARGET_REPO/.agents/tasks" -maxdepth 1 -name '*.json' | sort)
fi
[[ -n "${PRD_PATH:-}" && -f "$PRD_PATH" ]] \
  || die "No PRD JSON found. Pass --prd <path> or add .agents/tasks/*.json in the target."

# ---- Require backends exist -------------------------------------------------
require_backend() {
  local label="$1" cmd="$2" bin; bin="${cmd%% *}"
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

# ---- Run dir ----------------------------------------------------------------
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
RUN_DIR="$TARGET_REPO/.ralph/runs/$RUN_ID"
mkdir -p "$RUN_DIR"
RALPH_QUOTA_ARTIFACT="$RUN_DIR/provider-quota.env"
export RALPH_QUOTA_ARTIFACT

# ---- Preflight (repo contract) — block before any worktree/agent ------------
if ! bash "$SCRIPT_DIR/preflight.sh" "$TARGET_REPO" "$RUN_DIR/preflight.md"; then
  mkdir -p "$TARGET_REPO/.ralph"
  {
    echo "RUN_ID=$RUN_ID"; echo "STATUS=PREFLIGHT_FAILED"; echo "BRANCH="
    echo "WORKTREE="; echo "BASE_COMMIT=$(git -C "$TARGET_REPO" rev-parse HEAD 2>/dev/null)"
    echo "PREVIEW_URL="; echo "ARTIFACTS_DIR=$RUN_DIR"; echo "TARGET_REPO=$TARGET_REPO"
  } > "$TARGET_REPO/.ralph/last-run.env"
  echo "Preflight failed — repo baseline is not healthy. No worktree created, no agents run."
  echo "See $RUN_DIR/preflight.md and fix the repo contract first."
  exit 3
fi

# ---- Select the story -------------------------------------------------------
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

# ---- Dynamic ports + run environment ---------------------------------------
find_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}
if [[ "$PREVIEW_ENABLED" == "true" ]]; then
  RALPH_APP_PORT="${RALPH_APP_PORT:-$(find_free_port)}"
  RALPH_DB_PORT="${RALPH_DB_PORT:-$(find_free_port)}"
else
  RALPH_APP_PORT="${RALPH_APP_PORT:-}"
  RALPH_DB_PORT="${RALPH_DB_PORT:-}"
fi
RALPH_COMPOSE_PROJECT="ralph-$(printf '%s' "$RUN_ID" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '-')"
if [[ -n "$RALPH_APP_PORT" ]]; then
  RALPH_PREVIEW_URL="${RALPH_PREVIEW_URL:-http://$PREVIEW_HOST:$RALPH_APP_PORT}"
else
  RALPH_PREVIEW_URL="${RALPH_PREVIEW_URL:-}"
fi

# Export the run environment for check / preview / e2e / reviewer.
export RALPH_RUN_ID="$RUN_ID"
export RALPH_TARGET_REPO="$TARGET_REPO"
export RALPH_WORKTREE="$WORKDIR"
export RALPH_BRANCH="$BRANCH"
export RALPH_BASE_COMMIT="$BASE_REF"
export RALPH_APP_PORT RALPH_DB_PORT RALPH_PREVIEW_URL RALPH_COMPOSE_PROJECT

# Export for the python prompt renderer.
export WORKDIR BRANCH MAX_ITERATIONS CHECK_CMD RUN_DIR AGENTS_PATH \
       STORY_ID STORY_TITLE STORY_BLOCK VERDICT_REGEX PREVIEW_ENABLED

# ---- Helpers ----------------------------------------------------------------
render_prompt() {
  # render_prompt <template> <dst>   (everything else comes from the environment)
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
    "ITERATION": env.get("R_ITER", ""),
    "MAX_ITERATIONS": env.get("MAX_ITERATIONS", ""),
    "CHECK_CMD": env.get("CHECK_CMD", ""),
    "CHECK_STATUS": env.get("R_CHECK_STATUS", ""),
    "HANDOFF_PATH": env.get("HANDOFF_PATH", ""),
    "RUN_DIR": env.get("RUN_DIR", ""),
    "AGENTS_PATH": env.get("AGENTS_PATH", ""),
    "STORY_ID": env.get("STORY_ID", ""),
    "STORY_TITLE": env.get("STORY_TITLE", ""),
    "STORY_BLOCK": fc("STORY_BLOCK", ""),
    "PREVIOUS_REVIEW": fc("PREV_REVIEW_FILE", "none"),
    "PREVIOUS_CHECK": fc("PREV_CHECK_FILE", "none"),
    "PREVIOUS_PREVIEW": fc("PREV_PREVIEW_FILE", "none"),
    "PREVIOUS_E2E": fc("PREV_E2E_FILE", "none"),
    "GIT_DIFF": fc("CUR_DIFF_FILE", "(no changes)"),
    "CHECK_OUTPUT": fc("CUR_CHECK_FILE", "(no output)"),
    "PREVIEW_UP_OUTPUT": fc("CUR_PREVIEW_UP_FILE", "(preview not run)"),
    "E2E_OUTPUT": fc("CUR_E2E_FILE", "(e2e not run)"),
    "HANDOFF": fc("HANDOFF_SNAP_FILE", "(handoff not written yet)"),
    "PREVIEW_ENABLED": env.get("PREVIEW_ENABLED", ""),
    "PREVIEW_URL": env.get("RALPH_PREVIEW_URL", ""),
    "APP_PORT": env.get("RALPH_APP_PORT", ""),
    "DB_PORT": env.get("RALPH_DB_PORT", ""),
    "VERDICT_REGEX": env.get("VERDICT_REGEX", ""),
}
src = Path(tmpl).read_text()
for k, v in repl.items():
    src = src.replace("{{" + k + "}}", v or "")
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

run_stage() {
  # run_stage <command> <logfile>  -> returns command exit status. cwd = WORKDIR.
  local cmd="$1" logfile="$2" status
  # Mark descendants so a ralph spawned by the check skips its own preflight (#35).
  ( cd "$WORKDIR" && RALPH_IN_PREFLIGHT=1 eval "$cmd" ) >"$logfile" 2>&1
  status=$?
  return "$status"
}

write_last_run() {
  local status="$1"
  {
    echo "RUN_ID=$RUN_ID"
    echo "STATUS=$status"
    echo "BRANCH=$BRANCH"
    echo "WORKTREE=$WORKDIR"
    echo "BASE_COMMIT=$BASE_REF"
    echo "PREVIEW_URL=$RALPH_PREVIEW_URL"
    echo "ARTIFACTS_DIR=$RUN_DIR"
    echo "TARGET_REPO=$TARGET_REPO"
    echo "USE_WORKTREE=$USE_WORKTREE"
    echo "PROVIDER_QUOTA_PROVIDER=${RALPH_QUOTA_PROVIDER:-}"
    echo "PROVIDER_QUOTA_SCOPE=${RALPH_QUOTA_SCOPE:-}"
    echo "PROVIDER_QUOTA_OBSERVED_AT=${RALPH_QUOTA_OBSERVED_AT:-}"
    echo "PROVIDER_QUOTA_RESET_AT=${RALPH_QUOTA_RESET_AT:-}"
  } > "$TARGET_REPO/.ralph/last-run.env"
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
    echo "- Preview enabled: $PREVIEW_ENABLED"
    if [[ "$PREVIEW_ENABLED" == "true" ]]; then
      echo "- Preview URL: $RALPH_PREVIEW_URL"
      echo "- App port: $RALPH_APP_PORT   DB port: $RALPH_DB_PORT"
      echo "- Compose project: $RALPH_COMPOSE_PROJECT"
      echo "- Preview kept running: $PREVIEW_KEPT"
    fi
    echo ""
    echo "Artifacts: $RUN_DIR"
    echo ""
    echo "## Next steps"
    echo "- Inspect: git -C \"$WORKDIR\" diff \"$BASE_REF\""
    echo "- Integrate (after human approval; merges, re-checks, then auto-cleans up, keeps branch):"
    echo "    ralph integrate --repo \"$TARGET_REPO\" --run $RUN_ID"
    echo "- Cleanup only (no merge): ralph cleanup --repo \"$TARGET_REPO\" --run $RUN_ID"
  } > "$RUN_DIR/final_status.md"
}

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
  echo "PREVIEW_ENABLED=$PREVIEW_ENABLED"
  echo "PREVIEW_UP=$PREVIEW_UP"
  echo "PREVIEW_DOWN=$PREVIEW_DOWN"
  echo "PREVIEW_URL_CMD=$PREVIEW_URL_CMD"
  echo "E2E_CMD=$E2E_CMD"
  echo "KEEP_ON_PASS=$KEEP_ON_PASS"
  echo "KEEP_ON_FAIL=$KEEP_ON_FAIL"
  echo "PREVIEW_HOST=$PREVIEW_HOST"
  echo "RALPH_APP_PORT=$RALPH_APP_PORT"
  echo "RALPH_DB_PORT=$RALPH_DB_PORT"
  echo "RALPH_PREVIEW_URL=$RALPH_PREVIEW_URL"
  echo "RALPH_COMPOSE_PROJECT=$RALPH_COMPOSE_PROJECT"
} > "$RUN_DIR/config.resolved.env"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Ralph review loop"
echo "  target=$TARGET_REPO"
echo "  story=${STORY_ID}: ${STORY_TITLE}"
echo "  builder=$BUILDER  reviewer=$REVIEWER  max=$MAX_ITERATIONS"
echo "  preview=$PREVIEW_ENABLED${RALPH_PREVIEW_URL:+  url=$RALPH_PREVIEW_URL}"
echo "  artifacts=$RUN_DIR"
echo "═══════════════════════════════════════════════════════"

write_last_run "RUNNING"

PREV_REVIEW=""; PREV_CHECK=""; PREV_PREVIEW=""; PREV_E2E=""
OUTCOME="FAILED_MAX_ITERATIONS"
ITERS_RUN=0
BUILDER_ERROR=0
PREVIEW_STARTED="false"
PREVIEW_KEPT="false"
QUOTA_ROLE=""
LAST_PREVIEW_UP_LOG=""; LAST_E2E_LOG=""

for i in $(seq 1 "$MAX_ITERATIONS"); do
  ITERS_RUN="$i"
  echo ""
  echo "── Iteration $i of $MAX_ITERATIONS ──────────────────────"

  HANDOFF_PATH="$WORKDIR/.agent-handoff.md"
  BUILDER_PROMPT_R="$RUN_DIR/builder_prompt_$i.md"
  BUILDER_LOG="$RUN_DIR/builder_output_$i.log"
  CHECK_LOG="$RUN_DIR/check_$i.log"
  DIFF_PATCH="$RUN_DIR/diff_$i.patch"
  HANDOFF_SNAP="$RUN_DIR/handoff_$i.md"
  PREVIEW_UP_LOG="$RUN_DIR/preview_up_$i.log"
  PREVIEW_URL_TXT="$RUN_DIR/preview_url_$i.txt"
  E2E_LOG="$RUN_DIR/e2e_$i.log"
  REVIEWER_PROMPT_R="$RUN_DIR/reviewer_prompt_$i.md"
  REVIEWER_OUT="$RUN_DIR/reviewer_output_$i.md"

  # Context the renderer reads from env.
  export R_ITER="$i" HANDOFF_PATH
  export PREV_REVIEW_FILE="$PREV_REVIEW" PREV_CHECK_FILE="$PREV_CHECK"
  export PREV_PREVIEW_FILE="$PREV_PREVIEW" PREV_E2E_FILE="$PREV_E2E"

  # 1. Builder
  render_prompt "$BUILDER_PROMPT" "$BUILDER_PROMPT_R"
  echo "Running builder ($BUILDER)..."
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[RALPH_DRY_RUN] builder skipped." > "$BUILDER_LOG"
    echo "ralph dry-run iteration $i" >> "$WORKDIR/.ralph-dry-run.txt"
    printf '# Agent Handoff (dry run) iter %s\n' "$i" > "$HANDOFF_PATH"
    # Commit like a real builder so the worktree stays clean for integrate/cleanup.
    git -C "$WORKDIR" add -A >/dev/null 2>&1 || true
    git -C "$WORKDIR" commit -qm "ralph dry-run iter $i" >/dev/null 2>&1 || true
  else
    set +e; run_backend "$BUILDER_CMD" "$BUILDER_PROMPT_R" "$BUILDER_LOG"; BUILDER_RC=$?; set -e
    if ralph_detect_quota_exhaustion "$BUILDER_LOG" "${BUILDER_PROVIDER:-$BUILDER}"; then
      QUOTA_ROLE="builder"; OUTCOME="PROVIDER_QUOTA_EXHAUSTED"
      echo "Provider quota exhausted for '$RALPH_QUOTA_PROVIDER'${RALPH_QUOTA_RESET_AT:+; reset at $RALPH_QUOTA_RESET_AT} — halting immediately." >&2
      break
    fi
    if [[ "$BUILDER_RC" -ne 0 ]]; then
      # #37: a non-zero builder exit is a BACKEND error (crash, quota, argv-too-long) —
      # not work for the reviewer to judge. Fail fast with the reason instead of running
      # check+reviewer and silently burning the remaining iterations on a dead backend
      # (which is exactly what wasted issue-32's run: opencode hit 'Argument list too
      # long' and produced nothing, yet the loop retried it 5x).
      echo "Builder backend '$BUILDER' ERROR (exit=$BUILDER_RC) — halting review; no further iterations." >&2
      echo "  last builder output:" >&2; tail -n 6 "$BUILDER_LOG" 2>/dev/null | sed 's/^/    /' >&2
      OUTCOME="BUILDER_UNAVAILABLE"; BUILDER_ERROR=1
      break
    fi
  fi

  # 2. Check command (cwd = WORKDIR). Runs even in dry-run.
  echo "Running check ($CHECK_CMD)..."
  set +e; run_stage "$CHECK_CMD" "$CHECK_LOG"; CHECK_STATUS=$?; set -e
  echo "Check exit status: $CHECK_STATUS"

  # 3. Capture diff vs base
  git -C "$WORKDIR" add -A >/dev/null 2>&1 || true
  git -C "$WORKDIR" diff "$BASE_REF" > "$DIFF_PATCH" 2>/dev/null \
    || git -C "$WORKDIR" diff > "$DIFF_PATCH" 2>/dev/null || true

  # 4. Preview lifecycle (optional): preview-up -> preview-url -> e2e
  PREVIEW_OK="true"; PREVIEW_RAN="false"
  if [[ "$PREVIEW_ENABLED" == "true" ]]; then
    PREVIEW_RAN="true"
    echo "Running preview-up ($PREVIEW_UP)  [app=$RALPH_APP_PORT db=$RALPH_DB_PORT]..."
    set +e; run_stage "$PREVIEW_UP" "$PREVIEW_UP_LOG"; UP_STATUS=$?; set -e
    LAST_PREVIEW_UP_LOG="$PREVIEW_UP_LOG"
    if [[ "$UP_STATUS" -ne 0 ]]; then
      echo "preview-up FAILED (status=$UP_STATUS)."
      PREVIEW_OK="false"
    else
      PREVIEW_STARTED="true"
      # Resolve the preview URL (script stdout overrides the default), export for e2e.
      set +e; ( cd "$WORKDIR" && eval "$PREVIEW_URL_CMD" ) > "$PREVIEW_URL_TXT" 2>/dev/null; set -e
      URL_FROM_SCRIPT="$(head -n1 "$PREVIEW_URL_TXT" 2>/dev/null | tr -d '[:space:]')"
      if [[ -n "$URL_FROM_SCRIPT" ]]; then
        RALPH_PREVIEW_URL="$URL_FROM_SCRIPT"
      else
        printf '%s\n' "$RALPH_PREVIEW_URL" > "$PREVIEW_URL_TXT"
      fi
      export RALPH_PREVIEW_URL
      echo "Preview URL: $RALPH_PREVIEW_URL"
      echo "Running e2e ($E2E_CMD)..."
      set +e; run_stage "$E2E_CMD" "$E2E_LOG"; E2E_STATUS=$?; set -e
      LAST_E2E_LOG="$E2E_LOG"
      if [[ "$E2E_STATUS" -ne 0 ]]; then
        echo "e2e FAILED (status=$E2E_STATUS)."
        PREVIEW_OK="false"
      fi
    fi
  fi

  # 5. Snapshot handoff
  if [[ -f "$HANDOFF_PATH" ]]; then cp "$HANDOFF_PATH" "$HANDOFF_SNAP"
  else echo "(builder did not write a handoff this iteration)" > "$HANDOFF_SNAP"; fi

  # 6. Reviewer (always runs so it can see all logs)
  export R_CHECK_STATUS="$CHECK_STATUS"
  export CUR_DIFF_FILE="$DIFF_PATCH" CUR_CHECK_FILE="$CHECK_LOG"
  export HANDOFF_SNAP_FILE="$HANDOFF_SNAP"
  export CUR_PREVIEW_UP_FILE="" CUR_E2E_FILE=""
  if [[ "$PREVIEW_RAN" == "true" ]]; then
    export CUR_PREVIEW_UP_FILE="$PREVIEW_UP_LOG"
    [[ -f "$E2E_LOG" ]] && export CUR_E2E_FILE="$E2E_LOG"
  fi
  render_prompt "$REVIEWER_PROMPT" "$REVIEWER_PROMPT_R"
  echo "Running reviewer ($REVIEWER)..."
  if [[ "$DRY_RUN" == "1" ]]; then
    { echo "### Must-fix issues"; echo "- none (dry run)"; echo ""; echo "VERDICT: PASS"; } > "$REVIEWER_OUT"
  else
    set +e; run_backend "$REVIEWER_CMD" "$REVIEWER_PROMPT_R" "$REVIEWER_OUT"; REVIEWER_RC=$?; set -e
    if ralph_detect_quota_exhaustion "$REVIEWER_OUT" "${REVIEWER_PROVIDER:-$REVIEWER}"; then
      QUOTA_ROLE="reviewer"; OUTCOME="PROVIDER_QUOTA_EXHAUSTED"
      echo "Provider quota exhausted for '$RALPH_QUOTA_PROVIDER'${RALPH_QUOTA_RESET_AT:+; reset at $RALPH_QUOTA_RESET_AT} — halting immediately." >&2
      break
    fi
  fi

  # 7. Parse verdict (last matching line wins)
  VERDICT="$(grep -E "$VERDICT_REGEX" "$REVIEWER_OUT" 2>/dev/null | tail -n1 | grep -oE 'PASS|FAIL' | tail -n1 || true)"
  [[ -z "$VERDICT" ]] && { echo "No verdict line found; treating as FAIL."; VERDICT="FAIL"; }
  echo "Reviewer verdict: $VERDICT  (check_status=$CHECK_STATUS preview_ok=$PREVIEW_OK)"

  if [[ "$VERDICT" == "PASS" && "$CHECK_STATUS" -eq 0 && "$PREVIEW_OK" == "true" ]]; then
    OUTCOME="READY_FOR_HUMAN_REVIEW"
    break
  fi

  # Feed all failure logs back into the next builder iteration.
  PREV_REVIEW="$REVIEWER_OUT"
  PREV_CHECK="$CHECK_LOG"
  [[ "$PREVIEW_RAN" == "true" ]] && PREV_PREVIEW="$PREVIEW_UP_LOG" || PREV_PREVIEW=""
  if [[ "$PREVIEW_RAN" == "true" && -f "$E2E_LOG" ]]; then PREV_E2E="$E2E_LOG"; else PREV_E2E=""; fi
  echo "Validation failed (check/preview/e2e) or verdict FAIL — feeding feedback back to builder."
done

# ---- Preview teardown decision ---------------------------------------------
if [[ "$PREVIEW_ENABLED" == "true" && "$PREVIEW_STARTED" == "true" ]]; then
  KEEP="false"
  if [[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" && "$KEEP_ON_PASS" == "true" ]]; then KEEP="true"; fi
  if [[ "$OUTCOME" != "READY_FOR_HUMAN_REVIEW" && "$KEEP_ON_FAIL" == "true" ]]; then KEEP="true"; fi
  if [[ "$KEEP" == "true" ]]; then
    PREVIEW_KEPT="true"
    echo "Leaving preview running at $RALPH_PREVIEW_URL (keep policy)."
  else
    echo "Stopping preview ($PREVIEW_DOWN)..."
    set +e; run_stage "$PREVIEW_DOWN" "$RUN_DIR/preview_down_$ITERS_RUN.log"; set -e
  fi
fi

write_final_status "$OUTCOME" "$ITERS_RUN"
write_last_run "$OUTCOME"

echo ""
echo "═══════════════════════════════════════════════════════"
if [[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]]; then
  echo "  ✅ READY_FOR_HUMAN_REVIEW (after $ITERS_RUN iteration(s))"
elif [[ "$OUTCOME" == "BUILDER_UNAVAILABLE" ]]; then
  echo "  ❌ BUILDER_UNAVAILABLE — builder backend '$BUILDER' failed (exit ${BUILDER_RC:-?}); halted after $ITERS_RUN iteration(s)."
elif [[ "$OUTCOME" == "PROVIDER_QUOTA_EXHAUSTED" ]]; then
  echo "  ⏸ PROVIDER_QUOTA_EXHAUSTED — $QUOTA_ROLE provider '$RALPH_QUOTA_PROVIDER' paused${RALPH_QUOTA_RESET_AT:+ until $RALPH_QUOTA_RESET_AT}."
else
  echo "  ❌ $OUTCOME (after $ITERS_RUN iteration(s))"
fi
echo "───────────────────────────────────────────────────────"
echo "  Branch:    $BRANCH (NOT merged)"
[[ -n "$WORKTREE_PATH" ]] && echo "  Worktree:  $WORKTREE_PATH"
echo "  Artifacts: $RUN_DIR"
if [[ "$PREVIEW_ENABLED" == "true" && -n "$RALPH_PREVIEW_URL" ]]; then
  if [[ "$PREVIEW_KEPT" == "true" ]]; then
    echo "  Preview:   $RALPH_PREVIEW_URL  (running — open it to validate)"
  else
    echo "  Preview:   $RALPH_PREVIEW_URL  (stopped)"
  fi
fi
echo "  Integrate: ralph integrate --repo \"$TARGET_REPO\" --run $RUN_ID   (merges, re-checks, auto-cleans, keeps branch)"
echo "  Cleanup:   ralph cleanup --repo \"$TARGET_REPO\" --run $RUN_ID"
echo "═══════════════════════════════════════════════════════"

[[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]] && exit 0
exit 2
