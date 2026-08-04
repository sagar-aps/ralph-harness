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
#   RALPH_SNAPSHOT_INTERVAL  Seconds between WIP snapshots while the builder runs
#                        (default 60; <=0 disables). Snapshots are commits under
#                        refs/ralph/wip/<run-ts>/task-N/iter-M, taken WITHOUT
#                        touching the builder's git index. Recover after a kill:
#                          git -C <repo> show --stat <ref>
#                          git -C <worktree> restore --source=<ref> -- .

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

PLAN="${PLAN:-}"
[[ -n "$PLAN" ]] || die "PLAN is required (use --plan <dir-or-file>)."
[[ -e "$PLAN" ]] || die "Plan not found: $PLAN"
PLAN="$(cd "$(dirname "$PLAN")" && pwd)/$(basename "$PLAN")"

# Target config (check command + optional end-of-batch preview).
cfg_check=""; cfg_verify=""; cfg_primer=""
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
emit("cfg_verify", d.get("verify"))
emit("cfg_primer", d.get("primer"))
emit("cfg_prev_enabled", p.get("enabled"))
emit("cfg_up", p.get("up"))
emit("cfg_down", p.get("down"))
emit("cfg_url", p.get("url"))
emit("cfg_e2e", p.get("e2e"))
emit("cfg_host", p.get("host"))
# Normalized agent selection (#4): an optional "agents" block declares per-role
# provider/model/effort and/or a profile as a repo-level default.
# NOTE: keep this heredoc body free of apostrophes and unbalanced ()/{} — Bash 3.2
# (macOS default) scans $(...) heredoc bodies and desyncs on a lone quote/paren.
a = d.get("agents", {}) if isinstance(d, dict) else {}
b = a.get("builder", {}) if isinstance(a, dict) else {}
r = a.get("reviewer", {}) if isinstance(a, dict) else {}
emit("cfg_agent_profile", a.get("profile"))
emit("cfg_agent_builder_provider", b.get("provider"))
emit("cfg_agent_builder_model", b.get("model"))
emit("cfg_agent_builder_effort", b.get("effort"))
emit("cfg_agent_reviewer_provider", r.get("provider"))
emit("cfg_agent_reviewer_model", r.get("model"))
emit("cfg_agent_reviewer_effort", r.get("effort"))
PY
)"
fi

# Normalized agent selection (#4). Precedence (high->low): env/CLI flags >
# config.local.sh (sourced above) > ralph.target.json "agents" block > shipped
# default. The target block is applied here with := so it fills only knobs still
# unset after env and config.local; ralph_resolve_role_agents then composes the
# synthetic ralph-build/ralph-review backends (no-op when no spec/profile is set).
: "${RALPH_PROFILE:=${cfg_agent_profile:-}}"
: "${BUILDER_PROVIDER:=${cfg_agent_builder_provider:-}}"
: "${BUILDER_MODEL:=${cfg_agent_builder_model:-}}"
: "${BUILDER_EFFORT:=${cfg_agent_builder_effort:-}}"
: "${REVIEWER_PROVIDER:=${cfg_agent_reviewer_provider:-}}"
: "${REVIEWER_MODEL:=${cfg_agent_reviewer_model:-}}"
: "${REVIEWER_EFFORT:=${cfg_agent_reviewer_effort:-}}"
if declare -F ralph_resolve_role_agents >/dev/null 2>&1; then ralph_resolve_role_agents; fi

BUILDER="${BUILDER:-opencode}"
REVIEWER="${REVIEWER:-claude}"
CHECK_CMD="${CHECK_CMD:-${cfg_check:-./scripts/check.sh}}"
# Acceptance/verify gate: a heavier check run ONCE per task at PASS-time (when the
# fast check passed AND the reviewer approved). Empty = disabled (today's behavior).
VERIFY_CMD="${VERIFY_CMD:-${cfg_verify:-}}"
# Orchestrator-supplied repo primer injected into every builder prompt as {{PRIMER}}.
# A file path; relative paths resolve against the target repo. Empty = no primer.
PRIMER_FILE="${RALPH_PRIMER_FILE:-${cfg_primer:-}}"
if [[ -n "$PRIMER_FILE" && "$PRIMER_FILE" != /* ]]; then PRIMER_FILE="$TARGET_REPO/$PRIMER_FILE"; fi
export R_PRIMER_FILE="$PRIMER_FILE"
MAX_TASKS="${MAX_TASKS:-0}"
MAX_ITERATIONS="${MAX_ITERATIONS:-5}"   # per-task builder/reviewer attempts (verdict loop)
# Infra-error handling for the agent backends (distinct from PASS/FAIL): a backend
# that exits non-zero, or a reviewer with no parseable VERDICT, is an ERROR. We
# retry the SAME agent invocation (not a new builder attempt) up to AGENT_RETRIES
# times with exponential backoff; if still ERROR we halt the whole batch.
AGENT_RETRIES="${RALPH_AGENT_RETRIES:-2}"
AGENT_RETRY_DELAY="${RALPH_AGENT_RETRY_DELAY:-2}"   # seconds; doubles each retry
AGENT_ERROR_ATTEMPTS=$((AGENT_RETRIES + 1))
RESUME="${RESUME:-}"   # non-empty => resume the last batch run, skipping done tasks
AUTO_APPROVE_BUILDER="${AUTO_APPROVE_BUILDER:-false}"
STOP_ON_FAIL="${STOP_ON_FAIL:-false}"
ALLOW_DIRTY="${ALLOW_DIRTY:-false}"
VERDICT_REGEX="${VERDICT_REGEX:-^VERDICT: (PASS|FAIL|BLOCKED)}"
BUILDER_PROMPT="${BATCH_BUILDER_PROMPT:-$SCRIPT_DIR/PROMPT_batch_builder.md}"
REVIEWER_PROMPT="${BATCH_REVIEWER_PROMPT:-$SCRIPT_DIR/PROMPT_batch_reviewer.md}"
DRY_RUN="${RALPH_DRY_RUN:-}"

# WIP snapshots (SIGTERM resilience). The host CLI can SIGTERM a batch mid-builder;
# ralph otherwise commits only at end-of-attempt, so that work is lost. A background
# snapshotter commits the worktree to refs/ralph/wip/... every SNAPSHOT_INTERVAL
# seconds WITHOUT touching the builder's git index (see wip_snapshot).
SNAPSHOT_INTERVAL="${RALPH_SNAPSHOT_INTERVAL:-60}"   # seconds; <=0 disables
WIP_REF_NS="refs/ralph/wip"
SNAP_PID=""
WIP_REF_LAST=""
WIP_INDEX=""            # assigned once RUN_DIR is known (below)

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

# RALPH_USAGE=1 makes claude-CLI agents emit `--output-format json` so run_backend
# can capture per-attempt token/cost usage. Applies to the bare `claude` binary AND to
# claude-CLI wrappers (rlaude/zlaude and anything in RALPH_CLAUDE_LIKE) — they take the
# same flag. Other backends (codex/opencode/...) are left untouched. run_backend's
# extraction (always on) turns the JSON back into the plain-text log the verdict grep
# reads, so this stays safe. Off by default.
RALPH_CLAUDE_LIKE="${RALPH_CLAUDE_LIKE:-claude rlaude zlaude}"
if [[ "${RALPH_USAGE:-0}" == "1" ]]; then
  add_json_flag() {
    local c="$1" first name rest
    first="${c%% *}"; name="$(basename "$first")"
    [[ "$c" == *--output-format* ]] && { printf '%s' "$c"; return; }   # already set
    # The shipped claude backend is hermetic and therefore starts with `env -u ...`.
    # Add the CLI flag after its actual executable, not after the env wrapper.
    if [[ "$name" == "env" && "$c" == *" claude "* ]]; then
      printf '%s' "${c/ claude / claude --output-format json }"
      return
    fi
    case " $RALPH_CLAUDE_LIKE " in
      *" $name "*)                                    # claude CLI (or a known wrapper)
        if [[ "$c" == *" "* ]]; then rest="${c#* }"; printf '%s --output-format json %s' "$first" "$rest";
        else printf '%s --output-format json' "$c"; fi ;;
      *) printf '%s' "$c" ;;                          # not a claude CLI: unsupported flag
    esac
  }
  BUILDER_CMD="$(add_json_flag "$BUILDER_CMD")"
  REVIEWER_CMD="$(add_json_flag "$REVIEWER_CMD")"
fi
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

# ---- Resume vs fresh run ----------------------------------------------------
RESUMING="false"
COMPLETED_SET=" "
if [[ -n "$RESUME" ]]; then
  LRE="$TARGET_REPO/.ralph/last-run.env"
  [[ -f "$LRE" ]] || die "Cannot resume: no prior run recorded at $LRE"
  prev_run_id="$(grep -m1 '^RUN_ID=' "$LRE" | cut -d= -f2-)"
  prev_branch="$(grep -m1 '^BRANCH=' "$LRE" | cut -d= -f2-)"
  prev_wt="$(grep -m1 '^WORKTREE=' "$LRE" | cut -d= -f2-)"
  prev_art="$(grep -m1 '^ARTIFACTS_DIR=' "$LRE" | cut -d= -f2-)"
  prev_base="$(grep -m1 '^BASE_COMMIT=' "$LRE" | cut -d= -f2-)"
  [[ "$prev_run_id" == batch-* ]] || die "Cannot resume: last run '$prev_run_id' is not a batch run."
  [[ -n "$prev_branch" && -n "$prev_wt" && -d "$prev_wt" ]] \
    || die "Cannot resume: prior worktree is missing ($prev_wt). Start a fresh batch instead."
  RESUMING="true"
  TS="${prev_run_id#batch-}"
  BRANCH="$prev_branch"
  WORKDIR="$prev_wt"
  RUN_DIR="$prev_art"
  TASKS_DIR="$RUN_DIR/tasks"
  BASE_REF="${prev_base:-$(git -C "$WORKDIR" rev-parse HEAD)}"
  mkdir -p "$TASKS_DIR"
  echo "Resuming batch $prev_run_id on branch $BRANCH (worktree $WORKDIR)"
fi

# ---- Run dir ---------------------------------------------------------------
if [[ "$RESUMING" != "true" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)-$$"
  BRANCH="${BRANCH:-ralph/batch-$TS}"
  RUN_DIR="$TARGET_REPO/.agent-run/batch-$TS"
  TASKS_DIR="$RUN_DIR/tasks"
  mkdir -p "$TASKS_DIR"
fi
# Scratch index for WIP snapshots — lives in the run dir (outside the worktree, so it
# survives cleanup and never shows up in `git status`).
WIP_INDEX="$RUN_DIR/wip.index"

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

# ---- Shared worktree (created ONCE; reused on resume) ----------------------
if [[ "$RESUMING" == "true" ]]; then
  # Reuse the prior worktree/branch; figure out which tasks already PASSed so we
  # don't redo them.
  cur_branch="$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [[ "$cur_branch" == "$BRANCH" ]] \
    || die "Cannot resume: worktree $WORKDIR is on '$cur_branch', expected '$BRANCH'."
  for rf in "$RUN_DIR"/task-*-result.md; do
    [[ -f "$rf" ]] || continue
    if grep -q '^- Result: PASS' "$rf"; then
      idx="$(basename "$rf" | sed -E 's/^task-([0-9]+)-result\.md$/\1/')"
      COMPLETED_SET+="$idx "
    fi
  done
  echo "Resume: already-complete tasks =${COMPLETED_SET}"
else
  BASE_REF="$(git -C "$TARGET_REPO" rev-parse HEAD)"
  WT_BASE="${RALPH_WORKTREE_DIR:-$(dirname "$TARGET_REPO")/.ralph-worktrees}"
  mkdir -p "$WT_BASE"
  WORKDIR="$WT_BASE/$(basename "$TARGET_REPO")-batch-$TS"
  git -C "$TARGET_REPO" worktree add -b "$BRANCH" "$WORKDIR" >/dev/null \
    || die "Failed to create worktree."
fi

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
    "PREVIOUS_VERIFY": fc("R_PREV_VERIFY_FILE", "none"),
    "PRIMER": fc("R_PRIMER_FILE", "(no primer provided)"),
}
src = Path(tmpl).read_text()
for k, v in repl.items():
    src = src.replace("{{" + k + "}}", v or "")
Path(dst).write_text(src)
PY
}

# Per-attempt usage instrumentation. If a backend emitted Claude JSON
# (`--output-format json`), rewrite the log to the human-readable `.result` and tee
# token/cost usage to a sidecar next to the log. This is not optional polish: a raw
# one-line JSON blob would never match the `^VERDICT:` anchor the reviewer parse
# depends on, forcing spurious ERROR retries until MAX_ITERATIONS — a token-burn
# regression. Extracting `.result` back into the log the grep reads prevents that.
# Safe no-op for plain-text backends (codex/opencode/etc.): the log is left untouched
# and no sidecar is written. python3 is already a hard dependency of this loop.
extract_usage() {  # <logfile> <sidecar>
  local log="$1" side="$2"
  [[ -s "$log" ]] || return 0
  python3 - "$log" "$side" <<'PY' 2>/dev/null || true
import json, sys
log, side = sys.argv[1], sys.argv[2]
try:
    raw = open(log, encoding="utf-8", errors="replace").read()
except Exception:
    sys.exit(0)
# Find the Claude result object: try the whole file, then each line from the end
# (the JSON result is one line on stdout; stderr noise may precede it under 2>&1).
obj = None
for cand in [raw, *reversed(raw.splitlines())]:
    cand = cand.strip()
    if not cand or cand[0] != "{":
        continue
    try:
        o = json.loads(cand)
    except Exception:
        continue
    if isinstance(o, dict) and "result" in o:
        obj = o
        break
if obj is None:
    sys.exit(0)  # not Claude JSON -> leave the log as-is, write no sidecar
res = obj.get("result")
open(log, "w", encoding="utf-8").write((res if isinstance(res, str) else json.dumps(res)) + "\n")
u = obj.get("usage") or {}
num = lambda x: x if isinstance(x, (int, float)) else None
json.dump({
    "input": num(u.get("input_tokens")),
    "output": num(u.get("output_tokens")),
    "cache_read": num(u.get("cache_read_input_tokens")),
    "cache_creation": num(u.get("cache_creation_input_tokens")),
    "num_turns": num(obj.get("num_turns")),
    "duration_ms": num(obj.get("duration_ms")),
    "total_cost_usd": obj.get("total_cost_usd"),
}, open(side, "w", encoding="utf-8"), indent=2)
open(side, "a", encoding="utf-8").write("\n")
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
  # Always attempt extraction (safe no-op for non-JSON): if json output ever reaches
  # the verdict grep un-extracted, it silently never matches -> ERROR-retry storm.
  extract_usage "$logfile" "${logfile%.*}.usage.json"
  return "$status"
}

# ---- WIP snapshots (SIGTERM resilience) -------------------------------------
# Take ONE snapshot of the worktree into $WIP_REF_NS/$TS/task-N/iter-M.
#
# Critically, this must never touch the builder's git index: the builder is an
# autonomous agent that runs its own `git add`/`git commit`, and a concurrent
# `git add -A` would contend on index.lock and can hard-fail those commits. So we
# stage into a private index via GIT_INDEX_FILE and build the commit with
# write-tree/commit-tree — a path that only locks our own index and the one ref.
#
# EVERY failure path returns 0: under `set -euo pipefail` a failed snapshot must
# never be able to abort the batch. Snapshots are a recovery aid, not a gate.
wip_snapshot() {  # <label>
  local label="${1:-snapshot}" ref tree sha parent stamp
  [[ -n "${WORKDIR:-}" && -d "${WORKDIR:-}" ]] || return 0
  [[ -n "${WIP_INDEX:-}" ]] || return 0
  ref="$WIP_REF_NS/$TS/task-${IDX:-0}/iter-${ITER:-0}"
  {
    parent="$(git -C "$WORKDIR" rev-parse HEAD 2>/dev/null)" || return 0
    [[ -n "$parent" ]] || return 0
    GIT_INDEX_FILE="$WIP_INDEX" git -C "$WORKDIR" add -A >/dev/null 2>&1 || return 0
    tree="$(GIT_INDEX_FILE="$WIP_INDEX" git -C "$WORKDIR" write-tree 2>/dev/null)" || return 0
    [[ -n "$tree" ]] || return 0
    # Nothing changed since the last snapshot on this ref — skip the write (avoids
    # ref churn and object bloat while the builder is thinking rather than writing).
    # Still record the ref: it exists and is the valid recovery pointer, and the
    # periodic snapshotter runs in a SUBSHELL whose WIP_REF_LAST cannot propagate
    # here — so this is often the only place the parent learns the ref.
    if [[ "$tree" == "$(git -C "$WORKDIR" rev-parse -q --verify "$ref^{tree}" 2>/dev/null)" ]]; then
      WIP_REF_LAST="$ref"
      return 0
    fi
    stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
    # Forced identity so commit-tree cannot fail on a repo with no user.name/email.
    sha="$(printf 'ralph wip [%s] task %s iter %s @ %s\n' \
             "$label" "${IDX:-?}" "${ITER:-?}" "$stamp" \
           | GIT_AUTHOR_NAME=ralph GIT_AUTHOR_EMAIL=ralph@localhost \
             GIT_COMMITTER_NAME=ralph GIT_COMMITTER_EMAIL=ralph@localhost \
             git -C "$WORKDIR" commit-tree "$tree" -p "$parent" 2>/dev/null)" || return 0
    [[ -n "$sha" ]] || return 0
    # --create-reflog matters: core.logAllRefUpdates only auto-logs refs/heads,
    # refs/remotes, refs/notes and HEAD. With a reflog, superseded snapshots stay
    # reachable (gc.reflogExpire, 90d) instead of being pruned as unreachable.
    git -C "$WORKDIR" update-ref --create-reflog "$ref" "$sha" 2>/dev/null || return 0
    WIP_REF_LAST="$ref"
    printf '%s\t%s\t%s\n' "$sha" "$ref" "$label" \
      >> "$RUN_DIR/task-${IDX:-0}-iter-${ITER:-0}-wip.log" 2>/dev/null || true
    printf '%s\n' "$sha" > "$RUN_DIR/task-${IDX:-0}-iter-${ITER:-0}-wip.sha" 2>/dev/null || true
  } || true
  return 0
}

# Start the background snapshotter. MUST be called with the builder NOT yet running:
# the `cp` below is a plain read of the real index, which is only safe while nothing
# else is mutating it. Do not hoist this call out of the per-attempt loop.
start_snapshotter() {
  SNAP_PID=""
  [[ "${SNAPSHOT_INTERVAL:-0}" -gt 0 ]] 2>/dev/null || return 0
  [[ -n "${WIP_INDEX:-}" && -n "${WORKDIR:-}" && -d "${WORKDIR:-}" ]] || return 0
  # Seed the private index from the real one so it inherits the stat cache; each
  # tick then only rehashes genuinely-changed files instead of the whole tree.
  cp "$(git -C "$WORKDIR" rev-parse --git-path index 2>/dev/null)" "$WIP_INDEX" 2>/dev/null \
    || rm -f "$WIP_INDEX" 2>/dev/null || true
  local main_pid=$$
  # stdio MUST be detached from the parent's. Otherwise this subshell and its
  # `sleep` children inherit batch-loop's stdout/stderr; when the caller reads
  # those through a pipe (as `spawnSync` and `$(...)` do), the pipe is not closed
  # until every holder exits — so an orphaned `sleep` blocks the caller for a full
  # interval after the batch has finished.
  (
    # Do NOT inherit on_interrupt — a child running it would exit 130 and write a
    # bogus INTERRUPTED pointer on the parent's behalf.
    trap - INT TERM EXIT
    while :; do
      # Sleep in 1s slices rather than one long sleep: a killed subshell leaves its
      # in-flight `sleep` orphaned, so short slices bound that orphan to ~1s and
      # make the parent-liveness check responsive.
      _waited=0
      while [[ "$_waited" -lt "$SNAPSHOT_INTERVAL" ]]; do
        sleep 1
        _waited=$((_waited + 1))
        # If the parent was SIGKILLed every trap was skipped, so self-terminate
        # rather than looping forever writing refs into the user's repo.
        kill -0 "$main_pid" 2>/dev/null || exit 0
      done
      [[ -d "$WORKDIR" ]] || exit 0
      wip_snapshot "periodic"
    done
  ) </dev/null >/dev/null 2>&1 &
  SNAP_PID=$!
  return 0
}

stop_snapshotter() {
  [[ -n "${SNAP_PID:-}" ]] || return 0
  # Signal only our own child. NOT `kill -- -$$`: job control is off in a
  # non-interactive shell, so the snapshotter shares the batch-loop's process
  # group and a group kill would take the builder down with it.
  kill "$SNAP_PID" 2>/dev/null || true
  wait "$SNAP_PID" 2>/dev/null || true   # returns 143 when killed; must not trip set -e
  SNAP_PID=""
  return 0
}

# Run the BUILDER for one task attempt, retrying ONLY on infra ERROR (non-zero
# exit of the backend tool — not a code/check failure, which surfaces via check).
# Returns 0 if the builder ran; 1 if it errored after all retries (caller halts).
run_builder_attempt() {  # <prompt_file> <log_file>
  local prompt="$1" log="$2" i rc delay="$AGENT_RETRY_DELAY"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[RALPH_DRY_RUN] builder skipped." > "$log"
    printf 'batch dry-run task %s iter %s: %s\n' "$IDX" "$ITER" "$TITLE" >> "$WORKDIR/batch-dry-run.txt"
    printf '# Handoff (dry run) task %s iter %s\n- simulated change\n' "$IDX" "$ITER" > "$HANDOFF_PATH"
    return 0
  fi
  for (( i=1; i<=AGENT_ERROR_ATTEMPTS; i++ )); do
    set +e; run_backend "$BUILDER_CMD" "$prompt" "$log"; rc=$?; set -e
    [[ "$rc" -eq 0 ]] && return 0
    AGENT_ERROR_EXIT="$rc"
    echo "    builder ERROR (exit=$rc) — invocation $i/$AGENT_ERROR_ATTEMPTS"
    if [[ "$i" -lt "$AGENT_ERROR_ATTEMPTS" ]]; then sleep "$delay"; delay=$((delay * 2)); fi
  done
  return 1
}

# Run the REVIEWER, classifying the outcome as PASS | FAIL | ERROR (harness-detected,
# never trusted from model text). ERROR = backend non-zero exit OR no VERDICT line.
# Retries ONLY on ERROR with backoff. Sets REVIEWER_OUTCOME and VERDICT.
run_reviewer_attempt() {  # <prompt_file> <out_file>
  local prompt="$1" out="$2" i rc v delay="$AGENT_RETRY_DELAY"
  for (( i=1; i<=AGENT_ERROR_ATTEMPTS; i++ )); do
    if [[ "$DRY_RUN" == "1" ]]; then
      { echo "### Must-fix issues"; echo "- none (dry run)"; echo ""; echo "VERDICT: PASS"; } > "$out"; rc=0
    else
      set +e; run_backend "$REVIEWER_CMD" "$prompt" "$out"; rc=$?; set -e
    fi
    v="$(grep -E "$VERDICT_REGEX" "$out" 2>/dev/null | tail -n1 | grep -oE 'PASS|FAIL|BLOCKED' | tail -n1 || true)"
    if [[ "$rc" -eq 0 && -n "$v" ]]; then
      VERDICT="$v"; REVIEWER_OUTCOME="$v"; return 0
    fi
    AGENT_ERROR_EXIT="$rc"
    echo "    reviewer ERROR (exit=$rc, verdict='${v:-none}') — invocation $i/$AGENT_ERROR_ATTEMPTS"
    if [[ "$i" -lt "$AGENT_ERROR_ATTEMPTS" ]]; then sleep "$delay"; delay=$((delay * 2)); fi
  done
  REVIEWER_OUTCOME="ERROR"; VERDICT=""
  return 1
}

# Write the resume pointer. Called early with RUNNING (so a Ctrl-C / kill mid-run
# is still resumable), on interrupt with INTERRUPTED, and at the end with the
# final OUTCOME. `ralph status/integrate/cleanup/--resume` all read this file.
write_last_run() {
  local status="$1"
  mkdir -p "$TARGET_REPO/.ralph"
  {
    echo "RUN_ID=batch-$TS"
    echo "STATUS=$status"
    echo "BRANCH=$BRANCH"
    echo "WORKTREE=$WORKDIR"
    echo "BASE_COMMIT=$BASE_REF"
    if [[ "${PREVIEW_RAN:-false}" == "true" && "${PREVIEW_UP_OK:-}" == "true" ]]; then
      echo "PREVIEW_URL=$RALPH_PREVIEW_URL"
    else
      echo "PREVIEW_URL="
    fi
    echo "ARTIFACTS_DIR=$RUN_DIR"
    echo "TARGET_REPO=$TARGET_REPO"
    echo "RALPH_COMPOSE_PROJECT=${RALPH_COMPOSE_PROJECT:-}"
    echo "RALPH_APP_PORT=${RALPH_APP_PORT:-}"
    echo "RALPH_DB_PORT=${RALPH_DB_PORT:-}"
    echo "USE_WORKTREE=true"
    echo "WIP_REF=${WIP_REF_LAST:-}"
    echo "WIP_NS=${WIP_REF_NS:-}/${TS:-}"
  } > "$TARGET_REPO/.ralph/last-run.env"
}

# On Ctrl-C / kill, leave a valid resume pointer + hint (work so far is committed).
# NOTE: bash defers traps until the running foreground command returns, so if the
# builder is mid-turn this fires late or (after a SIGKILL) never. The periodic
# snapshotter — not this handler — is what actually protects mid-builder work.
on_interrupt() {
  trap - INT TERM
  stop_snapshotter
  wip_snapshot "interrupt"
  write_last_run "INTERRUPTED"
  echo ""
  echo "Batch INTERRUPTED (signal). Completed tasks are committed on $BRANCH."
  if [[ -n "${WIP_REF_LAST:-}" ]]; then
    echo ""
    echo "Uncommitted builder work was snapshotted to: $WIP_REF_LAST"
    echo "  inspect:  git -C \"$TARGET_REPO\" show --stat $WIP_REF_LAST"
    echo "  recover:  git -C \"$WORKDIR\" restore --source=$WIP_REF_LAST -- ."
    echo "  (a snapshot may catch a file mid-write — review before trusting it)"
  fi
  echo "Resume (skips already-PASSed tasks):"
  echo "  ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --builder $BUILDER --reviewer $REVIEWER --resume"
  exit 130
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
  echo "VERIFY_CMD=$VERIFY_CMD"
  echo "PRIMER_FILE=$PRIMER_FILE"
  echo "AUTO_APPROVE_BUILDER=$AUTO_APPROVE_BUILDER"
  echo "STOP_ON_FAIL=$STOP_ON_FAIL"
  echo "ALLOW_DIRTY=$ALLOW_DIRTY"
  echo "TASK_TOTAL=$TASK_TOTAL"
  echo "TASK_RUN_COUNT=$TASK_RUN_COUNT"
  echo "MAX_ITERATIONS=$MAX_ITERATIONS"
  echo "AGENT_RETRIES=$AGENT_RETRIES"
  echo "AGENT_RETRY_DELAY=$AGENT_RETRY_DELAY"
  echo "RESUMING=$RESUMING"
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
echo "  verify:        ${VERIFY_CMD:-(none)}"
echo "  primer:        ${PRIMER_FILE:-(none)}"
echo "  max attempts/task: $MAX_ITERATIONS   agent-error retries: $AGENT_RETRIES   resume: $RESUMING"
echo "  auto-approve builder: $AUTO_APPROVE_BUILDER   stop-on-fail: $STOP_ON_FAIL"
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

ATTEMPTED=0; COMPLETED=0; FAILED=0; SKIPPED=0; BLOCKED_COUNT=0
STOPPED_EARLY="false"
AGENT_ERROR_ROLE=""        # "builder" | "reviewer" when an unrecoverable ERROR halts the batch
AGENT_ERROR_EXIT=""
HALTED_TASK=""

# Resume pointer is valid from the first task onward, and a signal leaves it
# INTERRUPTED (not stale) so `--resume` works even if you stop the run on purpose.
write_last_run "RUNNING"
trap on_interrupt INT TERM
# Belt-and-braces: never leave a snapshotter behind on any exit path.
trap 'stop_snapshotter' EXIT

# ---- Sequential task loop ---------------------------------------------------
# Read the manifest on a dedicated fd (3) so stdin-reading backends (e.g.
# `opencode run`, `codex exec -`) launched inside the loop can't drain fd 0 and
# truncate the loop to a single task.
while IFS=$'\t' read -r IDX TITLE FN <&3; do
  [[ -z "$IDX" ]] && continue
  # Resume: skip tasks that already PASSed in the prior run (don't redo them).
  if [[ "$RESUMING" == "true" && "$COMPLETED_SET" == *" $IDX "* ]]; then
    echo "── Task $IDX/$TASK_TOTAL: $TITLE — already complete (resume), skipping ──"
    SKIPPED=$((SKIPPED + 1)); COMPLETED=$((COMPLETED + 1))
    { echo "## Task $IDX — $TITLE  [PASS] (completed in a prior run)"; echo ""; } >> "$CONTEXT_FILE"
    continue
  fi
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
  TASK_STATUS="FAIL"; ITERS_USED=0; VERIFY_STATUS=""
  PREV_REVIEW=""; PREV_CHECK=""; PREV_VERIFY=""
  # Final-iteration artifacts (the result file points at these).
  DIFF_PATCH="$RUN_DIR/task-$IDX-diff.patch"
  CHECK_LOG="$RUN_DIR/task-$IDX-check.log"
  VERIFY_LOG="$RUN_DIR/task-$IDX-verify.log"
  HANDOFF_SNAP="$RUN_DIR/task-$IDX-handoff.md"
  REVIEWER_OUT="$RUN_DIR/task-$IDX-reviewer.md"

  for ITER in $(seq 1 "$MAX_ITERATIONS"); do
    ITERS_USED="$ITER"
    echo "  • attempt $ITER/$MAX_ITERATIONS"
    BUILDER_PROMPT_R="$RUN_DIR/task-$IDX-iter-$ITER-builder-prompt.md"
    BUILDER_LOG="$RUN_DIR/task-$IDX-iter-$ITER-builder.log"
    ITER_CHECK_LOG="$RUN_DIR/task-$IDX-iter-$ITER-check.log"
    ITER_VERIFY_LOG="$RUN_DIR/task-$IDX-iter-$ITER-verify.log"
    ITER_DIFF="$RUN_DIR/task-$IDX-iter-$ITER-diff.patch"
    ITER_HANDOFF="$RUN_DIR/task-$IDX-iter-$ITER-handoff.md"
    REVIEWER_PROMPT_R="$RUN_DIR/task-$IDX-iter-$ITER-reviewer-prompt.md"
    ITER_REVIEWER_OUT="$RUN_DIR/task-$IDX-iter-$ITER-reviewer.md"

    export R_TASK_NUM="$IDX" R_TASK_TITLE="$TITLE" R_TASK_FILE="$TASK_FILE" \
           R_CONTEXT_FILE="$CONTEXT_FILE" HANDOFF_PATH \
           R_ITER="$ITER" R_PREV_REVIEW_FILE="$PREV_REVIEW" R_PREV_CHECK_FILE="$PREV_CHECK" \
           R_PREV_VERIFY_FILE="$PREV_VERIFY"

    # 1. Builder (retry on infra ERROR; halt the batch if unrecoverable)
    #
    # The builder runs FOREGROUND, and bash defers trap handlers until the current
    # foreground command returns — so on_interrupt cannot fire while it is running.
    # A concurrent snapshotter is therefore the only thing that can protect work in
    # this window, which is exactly where observed SIGTERMs landed.
    render_prompt "$BUILDER_PROMPT" "$BUILDER_PROMPT_R"
    echo "    builder ($BUILDER)..."
    start_snapshotter
    # Keep the `if !` CONDITION form: run_builder_attempt re-enables `set -e`
    # internally (its retry loop does `set +e; ...; set -e`), so wrapping the call
    # in a plain `set +e` does NOT protect it — its final `return 1` would trip
    # errexit and kill the batch instead of halting it as BUILDER_UNAVAILABLE.
    # A condition context suspends errexit for the whole call, which does.
    BUILDER_RC=0
    if ! run_builder_attempt "$BUILDER_PROMPT_R" "$BUILDER_LOG"; then BUILDER_RC=1; fi
    stop_snapshotter
    wip_snapshot "post-builder"   # before the check, so a kill during it is covered
    if [[ "$BUILDER_RC" -ne 0 ]]; then
      AGENT_ERROR_ROLE="builder"; HALTED_TASK="$IDX"
      break
    fi

    # Builder no-op guard (#22): exit 0 + a confident "done" report is NOT evidence of
    # work. If the attempt changed nothing vs the task's starting commit, it is a no-op —
    # never success. Skip the check + reviewer (an empty diff has nothing to judge, and a
    # weak reviewer might rubber-stamp it), feed pointed feedback, and retry. If no attempt
    # ever produces a diff, the task ends NO_CHANGES (a failure), not PASS.
    git -C "$WORKDIR" add -A >/dev/null 2>&1 || true
    if git -C "$WORKDIR" diff --cached --quiet "$HEAD_BEFORE" 2>/dev/null; then
      echo "    builder produced NO changes (empty diff vs $HEAD_BEFORE) — not success (#22)"
      TASK_STATUS="NO_CHANGES"
      NOOP_FB="$RUN_DIR/task-$IDX-iter-$ITER-noop.txt"
      printf '%s\n' \
        "STOP. Your previous attempt exited WITHOUT changing any files — an empty diff against the task starting commit." \
        "Whatever your summary claimed, the task is NOT done. Do not describe existing code as new work." \
        "Make the concrete file edits the task requires and save them. If you genuinely believe no edit is warranted," \
        "do not restate the task as complete — explain in the handoff exactly why, with evidence." > "$NOOP_FB"
      PREV_REVIEW="$NOOP_FB"; PREV_CHECK=""
      continue
    fi
    TASK_STATUS="FAIL"   # a real diff exists; back to FAIL until the reviewer PASSes

    # 2. Check
    echo "    check ($CHECK_CMD)..."
    # RALPH_IN_PREFLIGHT marks descendants so a ralph spawned by the check skips its
    # own preflight — prevents the self-host check -> npm test -> ralph recursion (#35).
    set +e; ( cd "$WORKDIR" && RALPH_IN_PREFLIGHT=1 eval "$CHECK_CMD" ) > "$ITER_CHECK_LOG" 2>&1; CHECK_STATUS=$?; set -e
    echo "    check exit: $CHECK_STATUS"

    # 3. Diff for this task so far (vs the task's starting commit)
    git -C "$WORKDIR" add -A >/dev/null 2>&1 || true
    git -C "$WORKDIR" diff --cached "$HEAD_BEFORE" > "$ITER_DIFF" 2>/dev/null \
      || git -C "$WORKDIR" diff "$HEAD_BEFORE" > "$ITER_DIFF" 2>/dev/null || true
    CHANGED_FILES="$(git -C "$WORKDIR" diff --cached --name-only "$HEAD_BEFORE" 2>/dev/null || true)"

    # 4. Handoff snapshot
    if [[ -f "$HANDOFF_PATH" ]]; then cp "$HANDOFF_PATH" "$ITER_HANDOFF"
    else echo "(builder did not write a handoff)" > "$ITER_HANDOFF"; fi

    # 5. Reviewer — harness classifies PASS | FAIL | ERROR (ERROR retried w/ backoff)
    export R_CHECK_STATUS="$CHECK_STATUS" R_DIFF_FILE="$ITER_DIFF" \
           R_CHECK_FILE="$ITER_CHECK_LOG" R_HANDOFF_FILE="$ITER_HANDOFF"
    render_prompt "$REVIEWER_PROMPT" "$REVIEWER_PROMPT_R"
    echo "    reviewer ($REVIEWER, read-only)..."
    run_reviewer_attempt "$REVIEWER_PROMPT_R" "$ITER_REVIEWER_OUT" || true

    # Point the canonical per-task artifacts at this (latest) attempt.
    cp "$ITER_CHECK_LOG" "$CHECK_LOG" 2>/dev/null || true
    cp "$ITER_DIFF" "$DIFF_PATCH" 2>/dev/null || true
    cp "$ITER_HANDOFF" "$HANDOFF_SNAP" 2>/dev/null || true
    cp "$ITER_REVIEWER_OUT" "$REVIEWER_OUT" 2>/dev/null || true

    if [[ "$REVIEWER_OUTCOME" == "ERROR" ]]; then
      # Harness-detected reviewer failure (bad exit / no VERDICT). Do NOT consume a
      # builder attempt and do NOT feed the error output back — halt the batch.
      AGENT_ERROR_ROLE="reviewer"; HALTED_TASK="$IDX"
      break
    fi
    echo "    verdict: $VERDICT (check=$CHECK_STATUS)"

    # BLOCKED: the reviewer judges the task unfixable within its scope (contradictory/
    # impossible acceptance, needs access or a product decision, or an architectural
    # change well beyond this task). Terminal — stop retrying and escalate to a human.
    # The partial work + the reviewer's blocker report are committed for the human.
    if [[ "$VERDICT" == "BLOCKED" ]]; then
      TASK_STATUS="BLOCKED"
      break
    fi
    if [[ "$VERDICT" == "PASS" && "$CHECK_STATUS" -eq 0 ]]; then
      # Acceptance/verify gate: the heavier check runs ONLY now — the fast check
      # passed AND the reviewer approved — so the expensive suite/build runs once
      # per task instead of on every attempt. A non-zero verify sends the task back
      # to iterate, with the verify log fed to the builder as {{PREVIOUS_VERIFY}}.
      VERIFY_STATUS=0
      if [[ -n "$VERIFY_CMD" ]]; then
        echo "    verify ($VERIFY_CMD)..."
        set +e; ( cd "$WORKDIR" && eval "$VERIFY_CMD" ) > "$ITER_VERIFY_LOG" 2>&1; VERIFY_STATUS=$?; set -e
        echo "    verify exit: $VERIFY_STATUS"
        cp "$ITER_VERIFY_LOG" "$VERIFY_LOG" 2>/dev/null || true
      fi
      if [[ "$VERIFY_STATUS" -eq 0 ]]; then
        TASK_STATUS="PASS"
        break
      fi
      echo "    reviewer approved but verify FAILED (exit $VERIFY_STATUS) — iterating"
      PREV_VERIFY="$ITER_VERIFY_LOG"
    fi
    # Feed this attempt's reviewer + check logs back into the next builder attempt.
    PREV_REVIEW="$ITER_REVIEWER_OUT"; PREV_CHECK="$ITER_CHECK_LOG"
    [[ "$ITER" -lt "$MAX_ITERATIONS" ]] && echo "    not passing — retrying with feedback"
  done

  # Unrecoverable agent (builder/reviewer) ERROR → halt: do not commit, do not
  # count this task as PASS/FAIL.
  if [[ -n "$AGENT_ERROR_ROLE" ]]; then
    echo "Task $IDX HALTED — $AGENT_ERROR_ROLE backend unavailable (ERROR after $AGENT_ERROR_ATTEMPTS attempts)."
    break
  fi

  if [[ "$TASK_STATUS" == "PASS" ]]; then COMPLETED=$((COMPLETED + 1))
  elif [[ "$TASK_STATUS" == "BLOCKED" ]]; then BLOCKED_COUNT=$((BLOCKED_COUNT + 1))
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
    [[ -n "$VERIFY_CMD" ]] && echo "- Verify exit: ${VERIFY_STATUS:-not reached}"
    echo "- Reviewer verdict: $VERDICT"
    echo "- PR provenance (paste into the PR): builder: $BUILDER, reviewer: $REVIEWER, iterations: $ITERS_USED"
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

  if [[ ( "$TASK_STATUS" == "FAIL" || "$TASK_STATUS" == "BLOCKED" ) && "$STOP_ON_FAIL" == "true" ]]; then
    echo "Task $IDX ended $TASK_STATUS and --stop-on-fail is set. Stopping batch."
    STOPPED_EARLY="true"
    break
  fi
done 3< "$MANIFEST"

# ---- End-of-batch preview (optional) ---------------------------------------
# Bring the whole branch up ONCE so the human can review the entire batch via a
# URL (same scripts as `ralph review`). Left running for review; `ralph cleanup`
# stops it via the preview-down script.
PREVIEW_RAN="false"; PREVIEW_UP_OK=""; E2E_OK=""
if [[ "$PREVIEW_ENABLED" == "true" && -z "$AGENT_ERROR_ROLE" ]]; then
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
# An unrecoverable agent ERROR is its OWN terminal state, distinct from
# COMPLETED_WITH_FAILURES (which means tasks ran and some failed review).
if [[ -n "$AGENT_ERROR_ROLE" ]]; then
  if [[ "$AGENT_ERROR_ROLE" == "reviewer" ]]; then OUTCOME="REVIEWER_UNAVAILABLE"
  else OUTCOME="BUILDER_UNAVAILABLE"; fi
elif [[ "$STOPPED_EARLY" == "true" ]]; then
  OUTCOME="STOPPED_ON_FAIL"
elif [[ "$FAILED" -gt 0 ]]; then
  OUTCOME="COMPLETED_WITH_FAILURES"
elif [[ "$PREVIEW_RAN" == "true" && ( "$PREVIEW_UP_OK" != "true" || "$E2E_OK" == "false" ) ]]; then
  OUTCOME="COMPLETED_WITH_FAILURES"
elif [[ "$BLOCKED_COUNT" -gt 0 ]]; then
  # No hard failures, but the reviewer flagged one or more tasks as structurally
  # blocked — its own terminal state that needs a human decision, not a rerun.
  OUTCOME="COMPLETED_WITH_BLOCKERS"
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
  echo "- Tasks attempted: $ATTEMPTED of $TASK_TOTAL (completed: $COMPLETED, failed: $FAILED, blocked: $BLOCKED_COUNT, skipped-on-resume: $SKIPPED)"
  if [[ "$PREVIEW_RAN" == "true" ]]; then
    echo "- Preview: ${PREVIEW_UP_OK:+up=$PREVIEW_UP_OK }${E2E_OK:+e2e=$E2E_OK }URL=$RALPH_PREVIEW_URL"
  elif [[ -n "$AGENT_ERROR_ROLE" ]]; then
    echo "- Preview: skipped (batch halted on $AGENT_ERROR_ROLE error)"
  else
    echo "- Preview: disabled"
  fi
  if [[ -n "$AGENT_ERROR_ROLE" ]]; then
    echo ""
    echo "## ⚠ Halted: $AGENT_ERROR_ROLE backend unavailable"
    echo ""
    echo "The **$AGENT_ERROR_ROLE** backend (\`$([[ "$AGENT_ERROR_ROLE" == reviewer ]] && echo "$REVIEWER" || echo "$BUILDER")\`) returned an"
    echo "ERROR — a non-zero exit$([[ "$AGENT_ERROR_ROLE" == reviewer ]] && echo ", or no \`VERDICT:\` line,") — on every one of"
    echo "$AGENT_ERROR_ATTEMPTS attempts (last exit: ${AGENT_ERROR_EXIT:-?}) while working task $HALTED_TASK."
    echo "This is treated as a tooling outage, NOT a task failure: no builder attempt was"
    echo "consumed and the error output was NOT fed back as feedback."
    echo ""
    echo "Most likely the CLI is logged out, rate-limited, or misconfigured. Re-authenticate"
    echo "or check quota, e.g.:"
    echo "  - claude:   run \`claude\` once to (re)login"
    echo "  - codex:    \`codex login\`"
    echo "  - droid:    re-run its login flow"
    echo "  - opencode: re-check its auth/plan"
    echo ""
    echo "Then RESUME — already-PASSed tasks stay committed and are skipped; the batch"
    echo "picks up at task $HALTED_TASK:"
    echo "  ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --builder $BUILDER --reviewer $REVIEWER --resume"
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
  echo "## PR provenance (copy the matching line into each PR body/comment)"
  echo ""
  while IFS=$'\t' read -r IDX TITLE FN; do
    [[ -z "$IDX" ]] && continue
    rf="$RUN_DIR/task-$IDX-result.md"
    [[ -f "$rf" ]] || continue
    prov="$(grep -m1 '^- PR provenance' "$rf" | sed 's/^- PR provenance[^:]*: //')"
    [[ -n "$prov" ]] && echo "- Task $IDX: $prov"
  done < "$MANIFEST"
  echo ""
  echo "## Failures / blockers"
  blockers=0
  while IFS=$'\t' read -r IDX TITLE FN; do
    [[ -z "$IDX" ]] && continue
    rf="$RUN_DIR/task-$IDX-result.md"
    [[ -f "$rf" ]] || continue
    if grep -q '^- Result: FAIL' "$rf"; then
      echo "- [FAIL] Task $IDX ($TITLE): see $RUN_DIR/task-$IDX-reviewer.md and task-$IDX-check.log"
      blockers=$((blockers + 1))
    elif grep -q '^- Result: BLOCKED' "$rf"; then
      echo "- [BLOCKED — needs human] Task $IDX ($TITLE): the reviewer judged it unfixable in scope. Read its blocker report in $RUN_DIR/task-$IDX-reviewer.md (and the builder handoff task-$IDX-handoff.md), decide/unblock, then \`--resume\`."
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

# Final resume/status pointer (also read by status / integrate / cleanup).
trap - INT TERM
stop_snapshotter

# Sweep this run's WIP snapshots once the work is safely committed on the branch —
# otherwise refs accumulate one-per-attempt forever and permanently pin objects.
# Only on the clean outcome: on any other ending the snapshots are still the
# user's recovery path.
if [[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]]; then
  while read -r _wipref; do
    [[ -n "$_wipref" ]] || continue
    git -C "$TARGET_REPO" update-ref -d "$_wipref" 2>/dev/null || true
  done < <(git -C "$TARGET_REPO" for-each-ref --format='%(refname)' "$WIP_REF_NS/$TS" 2>/dev/null || true)
  rm -f "$WIP_INDEX" 2>/dev/null || true
  WIP_REF_LAST=""
fi

write_last_run "$OUTCOME"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Batch $OUTCOME"
echo "  attempted=$ATTEMPTED completed=$COMPLETED failed=$FAILED blocked=$BLOCKED_COUNT skipped-on-resume=$SKIPPED"
echo "───────────────────────────────────────────────────────"
echo "  Branch:    $BRANCH (NOT merged)"
echo "  Worktree:  $WORKDIR"
echo "  Report:    $REPORT"
if [[ -n "$AGENT_ERROR_ROLE" ]]; then
  agent_name="$([[ "$AGENT_ERROR_ROLE" == reviewer ]] && echo "$REVIEWER" || echo "$BUILDER")"
  echo "  ⚠ Halted: $AGENT_ERROR_ROLE backend ($agent_name) unavailable after $AGENT_ERROR_ATTEMPTS attempts (last exit ${AGENT_ERROR_EXIT:-?})."
  echo "  Re-authenticate that CLI, then resume (completed tasks are skipped):"
  echo "    ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --builder $BUILDER --reviewer $REVIEWER --resume"
  echo "═══════════════════════════════════════════════════════"
  exit 4
fi
if [[ "$PREVIEW_RAN" == "true" && "$PREVIEW_UP_OK" == "true" ]]; then
  echo "  Preview:   $RALPH_PREVIEW_URL  (running — open it to review the whole batch)"
elif [[ "$PREVIEW_RAN" == "true" ]]; then
  echo "  Preview:   FAILED to start — see $RUN_DIR/preview-up.log"
fi
if [[ "$BLOCKED_COUNT" -gt 0 ]]; then
  echo "  ⚠ $BLOCKED_COUNT task(s) BLOCKED (need a human decision) — see 'Failures / blockers' in the report."
  echo "    After you unblock them, resume to retry only the unfinished tasks:"
  echo "    ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --builder $BUILDER --reviewer $REVIEWER --resume"
fi
echo "  Integrate (after review): ralph integrate --repo \"$TARGET_REPO\""
echo "  Cleanup:   ralph cleanup --repo \"$TARGET_REPO\""
echo "═══════════════════════════════════════════════════════"

[[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]] && exit 0
exit 2
