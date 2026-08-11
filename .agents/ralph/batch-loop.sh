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
#   RALPH_ALLOW_CONCURRENT=1  Bypass the per-target batch lock. The caller must
#                        give concurrent runs separate worktrees.
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
[[ -f "$SCRIPT_DIR/efficiency.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/efficiency.sh"; }
[[ -f "$SCRIPT_DIR/round-usage.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/round-usage.sh"; }
[[ -f "$SCRIPT_DIR/reported-model.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/reported-model.sh"; }
[[ -f "$SCRIPT_DIR/orchestrator-budget.sh" ]] && { # shellcheck source=/dev/null
  . "$SCRIPT_DIR/orchestrator-budget.sh"; }
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

# Batch owns target-local mutable state, so serialize runs per target. The open fd
# is the lock: the kernel releases it on every exit path, including SIGKILL. The
# file intentionally remains as a harmless place to flock; its text is diagnostic
# metadata only and can never make a future run look locked.
if [[ "${RALPH_ALLOW_CONCURRENT:-}" != "1" ]]; then
  command -v flock >/dev/null 2>&1 || die "flock is required to run ralph batch safely."
  mkdir -p "$TARGET_REPO/.ralph"
  BATCH_LOCK_FILE="$TARGET_REPO/.ralph/batch.lock"
  # Append-open does not erase the holder metadata before a contender learns
  # whether it owns the lock.
  exec 9>>"$BATCH_LOCK_FILE"
  if ! flock -n 9; then
    active_batch="$(sed -n '1p' "$BATCH_LOCK_FILE" 2>/dev/null || true)"
    [[ -n "$active_batch" ]] || active_batch="active batch metadata unavailable"
    die "Another batch is already active for $TARGET_REPO ($active_batch). Refusing to run concurrently; use --allow-concurrent only with separate worktrees."
  fi
  printf 'run=batch-pending pid=%s\n' "$$" > "$BATCH_LOCK_FILE"
fi

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
# Identity marker (issue-53): declarative identity configuration
i = d.get("identity", {}) if isinstance(d, dict) else {}
emit("cfg_identity_enabled", i.get("enabled"))
emit("cfg_identity_wrapper", i.get("wrapper"))
emit("cfg_identity_role", i.get("role"))
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
# A file path; relative paths resolve against the target repo. Deliberate no-primer
# runs must set RALPH_PRIMER_OPTOUT=1; otherwise an unusable primer is warned about.
PRIMER_FILE="${RALPH_PRIMER_FILE:-${cfg_primer:-}}"
if [[ -n "$PRIMER_FILE" && "$PRIMER_FILE" != /* ]]; then PRIMER_FILE="$TARGET_REPO/$PRIMER_FILE"; fi
PRIMER_STATUS="loaded"
PRIMER_WARNING=""
if [[ "${RALPH_PRIMER_OPTOUT:-}" == "1" ]]; then
  PRIMER_STATUS="deliberate-opt-out"
  PRIMER_FILE=""
elif [[ -z "$PRIMER_FILE" ]]; then
  PRIMER_STATUS="unset"
  PRIMER_WARNING="WARNING: Builder is running WITHOUT a repo primer (probable misconfiguration). Resolution chain checked: RALPH_PRIMER_FILE, then ralph.target.json .primer. Set RALPH_PRIMER_OPTOUT=1 to deliberately run without one."
elif [[ ! -f "$PRIMER_FILE" ]]; then
  PRIMER_STATUS="missing"
  PRIMER_WARNING="WARNING: Builder is running WITHOUT a repo primer because the resolved file is missing: $PRIMER_FILE. Resolution chain checked: RALPH_PRIMER_FILE, then ralph.target.json .primer. Set RALPH_PRIMER_OPTOUT=1 to deliberately run without one."
elif ! grep -q '[^[:space:]]' "$PRIMER_FILE"; then
  PRIMER_STATUS="empty"
  PRIMER_WARNING="WARNING: Builder is running WITHOUT a repo primer because the resolved file is empty: $PRIMER_FILE. Resolution chain checked: RALPH_PRIMER_FILE, then ralph.target.json .primer. Set RALPH_PRIMER_OPTOUT=1 to deliberately run without one."
fi
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
BUILDER_REQUESTED_MODEL="${BUILDER_MODEL:-$(ralph_command_model_values "$BUILDER_CMD" | head -n1)}"
REVIEWER_REQUESTED_MODEL="${REVIEWER_MODEL:-$(ralph_command_model_values "$REVIEWER_CMD" | head -n1)}"
BUILDER_REQUESTED_MODEL="${BUILDER_REQUESTED_MODEL:-default}"
REVIEWER_REQUESTED_MODEL="${REVIEWER_REQUESTED_MODEL:-default}"
BUILDER_RESOLVED_PROVIDER="${BUILDER_PROVIDER:-$BUILDER}"
REVIEWER_RESOLVED_PROVIDER="${REVIEWER_PROVIDER:-$REVIEWER}"
BUILDER_RESOLVED_MODEL="$BUILDER_REQUESTED_MODEL"
REVIEWER_RESOLVED_MODEL="$REVIEWER_REQUESTED_MODEL"
if [[ "$BUILDER_RESOLVED_MODEL" == "default" ]]; then BUILDER_RESOLVED_MODEL="unknown"; fi
if [[ "$REVIEWER_RESOLVED_MODEL" == "default" ]]; then REVIEWER_RESOLVED_MODEL="unknown"; fi
BUILDER_RESOLVED_PROVIDER="${BUILDER_RESOLVED_PROVIDER:-unknown}"
REVIEWER_RESOLVED_PROVIDER="${REVIEWER_RESOLVED_PROVIDER:-unknown}"

# RALPH_USAGE=1 makes agents emit machine-readable usage so run_backend can capture
# per-attempt tokens/cost. Two families are supported, each with its own flag and its
# own JSON shape (see .agents/ralph/references/TOKEN_ECONOMICS.md):
#
#   claude-CLI family  --output-format json   cache_read_input_tokens / cache_creation_input_tokens
#   codex              --json (JSONL)         cached_input_tokens / cache_write_input_tokens
#
# opencode is deliberately NOT instrumented: it accepts `--format json` but its usage
# field names are unverified (it hangs when invoked non-interactively — #44), and
# injecting a flag whose output shape we cannot parse would leave the reviewer's
# `^VERDICT:` grep staring at JSON, which silently burns every attempt. Unknown beats
# broken; revisit when #44 lands.
#
# run_backend's extraction (always on) turns either shape back into the plain-text log
# the verdict grep reads, and an unrecognised JSON shape is salvaged rather than left to
# break the verdict parse (see extract_usage) -- which is what makes this safe to have
# ON BY DEFAULT. Cost visibility is the whole point of the harness on capped plans, so
# it is opt-OUT: set RALPH_USAGE=0 to disable.
RALPH_CLAUDE_LIKE="${RALPH_CLAUDE_LIKE:-claude rlaude zlaude}"
RALPH_CODEX_LIKE="${RALPH_CODEX_LIKE:-codex}"
if [[ "${RALPH_USAGE:-1}" == "1" ]]; then
  # Is this executable (or backend) name a claude CLI? `claude*` covers the plain CLI
  # AND the hyphenated model-pinned aliases (claude-sonnet, claude-haiku, …);
  # RALPH_CLAUDE_LIKE covers the wrappers that do not carry the name (rlaude, zlaude,
  # plus anything the operator configured).
  claude_family_name() {
    local n="${1:-}"
    [[ -n "$n" ]] || return 1
    case "$n" in claude*) return 0 ;; esac
    case " $RALPH_CLAUDE_LIKE " in *" $n "*) return 0 ;; esac
    return 1
  }
  # Model-pinned aliases commonly start with an env wrapper
  # (`env -u ANTHROPIC_API_KEY … claude-sonnet -p …`). The flag belongs to the CLAUDE
  # CLI, not to env, so walk past env's OWN arguments — `-u NAME`, the inline/long
  # forms, `-i`, `-`, `VAR=value` assignments — to the real executable and inject
  # immediately after it (before its args).
  #
  # Injecting after `env` instead is what broke #72: `claude-sonnet` never matched a
  # bare-word `claude` regex, so it fell through to the backend-name `claude-*` branch
  # and produced `env --output-format json -u … claude-sonnet …`. macOS/BSD
  # /usr/bin/env rejects that ("illegal option -- o"), so every attempt exited 1 and
  # the run died as `builder backend unavailable`.
  env_inject_json_flag() {
    local c="$1" backend="$2" pre="" rest ws tok base
    rest="$c"
    [[ "$rest" =~ ^([[:space:]]*)([^[:space:]]+)(.*)$ ]] || return 1
    pre+="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"; rest="${BASH_REMATCH[3]}"   # env itself
    while [[ "$rest" =~ ^([[:space:]]*)([^[:space:]]+)(.*)$ ]]; do
      ws="${BASH_REMATCH[1]}"; tok="${BASH_REMATCH[2]}"; rest="${BASH_REMATCH[3]}"
      case "$tok" in
        -u|--unset|-C|--chdir|-P|-S|--split-string)   # env option whose value is the NEXT token
          pre+="$ws$tok"
          if [[ "$rest" =~ ^([[:space:]]*)([^[:space:]]+)(.*)$ ]]; then
            pre+="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"; rest="${BASH_REMATCH[3]}"
          fi ;;
        -*|*=*) pre+="$ws$tok" ;;                     # env's own flags (incl. `-`), VAR=value
        *)                                            # first non-option: the real executable
          base="$(basename "$tok")"
          claude_family_name "$base" || claude_family_name "$backend" || return 1
          printf '%s%s%s --output-format json%s' "$pre" "$ws" "$tok" "$rest"
          return 0 ;;
      esac
    done
    return 1
  }
  add_json_flag() {
    local c="$1" backend="$2" first name rest injected
    first="${c%% *}"; name="$(basename "$first")"
    [[ "$c" == *--output-format* || "$c" == *" --json"* ]] && { printf '%s' "$c"; return; }
    if [[ "$name" == "env" ]]; then
      # Behind env we either place the flag after the real claude executable, or leave
      # the command completely alone — never after `env`, which is not valid there.
      if injected="$(env_inject_json_flag "$c" "$backend")"; then printf '%s' "$injected"
      else printf '%s' "$c"; fi
      return
    fi
    case " $RALPH_CODEX_LIKE " in
      *" $name "*)
        # codex takes --json on the `exec` subcommand. Insert straight after `exec` so
        # it lands ahead of the sandbox/effort flags and the trailing stdin `-`.
        if [[ "$c" == *" exec "* ]]; then printf '%s' "${c/ exec / exec --json }"; else printf '%s' "$c"; fi
        return ;;
    esac
    case " $RALPH_CLAUDE_LIKE " in
      *" $name "*|*" $backend "*)                     # claude CLI (or a known wrapper)
        if [[ "$c" == *" "* ]]; then rest="${c#* }"; printf '%s --output-format json %s' "$first" "$rest";
        else printf '%s --output-format json' "$c"; fi ;;
      *)
        case "$backend" in
          claude-*)                                    # model-pinned/custom Claude alias
            if [[ "$c" == *" "* ]]; then rest="${c#* }"; printf '%s --output-format json %s' "$first" "$rest";
            else printf '%s --output-format json' "$c"; fi ;;
          *) printf '%s' "$c" ;;                      # not a claude CLI: unsupported flag
        esac ;;
    esac
  }
  BUILDER_CMD="$(add_json_flag "$BUILDER_CMD" "$BUILDER")"
  REVIEWER_CMD="$(add_json_flag "$REVIEWER_CMD" "$REVIEWER")"
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

# The operator-resolved selection, kept so a per-task efficiency rung (#62) can be
# applied to ONE task and then undone before the next one. Nothing reads these
# unless efficiency mode is on.
BASE_BUILDER="$BUILDER"; BASE_REVIEWER="$REVIEWER"
BASE_BUILDER_CMD="$BUILDER_CMD"; BASE_REVIEWER_CMD="$REVIEWER_CMD"
BASE_BUILDER_PROVIDER="${BUILDER_PROVIDER:-}"; BASE_REVIEWER_PROVIDER="${REVIEWER_PROVIDER:-}"
BASE_BUILDER_MODEL="${BUILDER_MODEL:-}"; BASE_REVIEWER_MODEL="${REVIEWER_MODEL:-}"
BASE_BUILDER_REQUESTED_MODEL="$BUILDER_REQUESTED_MODEL"
BASE_REVIEWER_REQUESTED_MODEL="$REVIEWER_REQUESTED_MODEL"
BASE_BUILDER_RESOLVED_PROVIDER="$BUILDER_RESOLVED_PROVIDER"
BASE_REVIEWER_RESOLVED_PROVIDER="$REVIEWER_RESOLVED_PROVIDER"
BASE_BUILDER_RESOLVED_MODEL="$BUILDER_RESOLVED_MODEL"
BASE_REVIEWER_RESOLVED_MODEL="$REVIEWER_RESOLVED_MODEL"
BASE_BUILDER_POOL="${RALPH_BUILDER_CREDENTIAL_POOL:-}"
BASE_REVIEWER_POOL="${RALPH_REVIEWER_CREDENTIAL_POOL:-}"

# Put the operator's own selection back (start of every task under efficiency mode,
# so one task's rung never leaks into the next).
efficiency_restore_defaults() {
  BUILDER="$BASE_BUILDER"; REVIEWER="$BASE_REVIEWER"
  BUILDER_CMD="$BASE_BUILDER_CMD"; REVIEWER_CMD="$BASE_REVIEWER_CMD"
  BUILDER_PROVIDER="$BASE_BUILDER_PROVIDER"; REVIEWER_PROVIDER="$BASE_REVIEWER_PROVIDER"
  BUILDER_MODEL="$BASE_BUILDER_MODEL"; REVIEWER_MODEL="$BASE_REVIEWER_MODEL"
  BUILDER_REQUESTED_MODEL="$BASE_BUILDER_REQUESTED_MODEL"
  REVIEWER_REQUESTED_MODEL="$BASE_REVIEWER_REQUESTED_MODEL"
  BUILDER_RESOLVED_PROVIDER="$BASE_BUILDER_RESOLVED_PROVIDER"
  REVIEWER_RESOLVED_PROVIDER="$BASE_REVIEWER_RESOLVED_PROVIDER"
  BUILDER_RESOLVED_MODEL="$BASE_BUILDER_RESOLVED_MODEL"
  REVIEWER_RESOLVED_MODEL="$BASE_REVIEWER_RESOLVED_MODEL"
  RALPH_BUILDER_CREDENTIAL_POOL="$BASE_BUILDER_POOL"
  RALPH_REVIEWER_CREDENTIAL_POOL="$BASE_REVIEWER_POOL"
  export RALPH_BUILDER_CREDENTIAL_POOL RALPH_REVIEWER_CREDENTIAL_POOL
}

# Hand both roles to the rung ralph_efficiency_select picked, resolving its commands
# exactly the way the boot path does (auto-approve stripping, read-only reviewer,
# usage JSON flag) so a rung-dispatched task is instrumented like any other. The
# provider/model pins are cleared: they were aimed at the backend the rung replaced,
# and reporting them here would misattribute the run.
#
# A rung the machine cannot run (unknown backend name, or a command whose executable
# is not installed) is a LAUNCH failure like any other: it returns non-zero with the
# reason in RUNG_BIND_ERROR instead of dying, so #75's escalation can climb past it
# (see launch_escalate). Nothing is assigned until every check has passed, so a
# refused rung leaves the previous selection intact.
RUNG_BIND_ERROR=""
efficiency_apply_rung() {
  local new_builder="$RALPH_EFFICIENCY_SELECT_BUILDER"
  local new_reviewer="$RALPH_EFFICIENCY_SELECT_REVIEWER"
  local new_builder_cmd new_reviewer_cmd spec bin
  RUNG_BIND_ERROR=""
  new_builder_cmd="$(builder_cmd_for "$new_builder")"
  new_reviewer_cmd="$(reviewer_cmd_for "$new_reviewer")"
  if [[ -z "$new_builder_cmd" ]]; then
    RUNG_BIND_ERROR="names an unknown builder backend: $new_builder"; return 1
  fi
  if [[ -z "$new_reviewer_cmd" ]]; then
    RUNG_BIND_ERROR="names an unknown reviewer backend: $new_reviewer"; return 1
  fi
  if declare -F add_json_flag >/dev/null 2>&1; then
    new_builder_cmd="$(add_json_flag "$new_builder_cmd" "$new_builder")"
    new_reviewer_cmd="$(add_json_flag "$new_reviewer_cmd" "$new_reviewer")"
  fi
  if [[ "$DRY_RUN" != "1" ]]; then
    for spec in "$new_builder_cmd" "$new_reviewer_cmd"; do
      bin="${spec%% *}"
      if ! command -v "$bin" >/dev/null 2>&1; then
        RUNG_BIND_ERROR="backend not found on PATH: $bin"; return 1
      fi
    done
  fi
  BUILDER="$new_builder"; REVIEWER="$new_reviewer"
  BUILDER_CMD="$new_builder_cmd"; REVIEWER_CMD="$new_reviewer_cmd"
  BUILDER_PROVIDER=""; REVIEWER_PROVIDER=""; BUILDER_MODEL=""; REVIEWER_MODEL=""
  BUILDER_REQUESTED_MODEL="$(ralph_command_model_values "$BUILDER_CMD" | head -n1)"
  REVIEWER_REQUESTED_MODEL="$(ralph_command_model_values "$REVIEWER_CMD" | head -n1)"
  BUILDER_REQUESTED_MODEL="${BUILDER_REQUESTED_MODEL:-default}"
  REVIEWER_REQUESTED_MODEL="${REVIEWER_REQUESTED_MODEL:-default}"
  BUILDER_RESOLVED_PROVIDER="$BUILDER"; REVIEWER_RESOLVED_PROVIDER="$REVIEWER"
  BUILDER_RESOLVED_MODEL="$BUILDER_REQUESTED_MODEL"
  REVIEWER_RESOLVED_MODEL="$REVIEWER_REQUESTED_MODEL"
  if [[ "$BUILDER_RESOLVED_MODEL" == "default" ]]; then BUILDER_RESOLVED_MODEL="unknown"; fi
  if [[ "$REVIEWER_RESOLVED_MODEL" == "default" ]]; then REVIEWER_RESOLVED_MODEL="unknown"; fi
  RALPH_BUILDER_CREDENTIAL_POOL="$RALPH_EFFICIENCY_SELECT_BUILDER_POOL"
  RALPH_REVIEWER_CREDENTIAL_POOL="$RALPH_EFFICIENCY_SELECT_REVIEWER_POOL"
  export RALPH_BUILDER_CREDENTIAL_POOL RALPH_REVIEWER_CREDENTIAL_POOL
  return 0
}

# ---- Launch-failure escalation (#75) — efficiency only ----------------------
# A backend that never RAN is not a verdict: nothing was built and nothing was
# reviewed, so #64's review-failure escalation (which triggers on a spent iteration
# budget) can never see it. Before this, one unlaunchable backend halted the WHOLE
# batch as BUILDER_UNAVAILABLE/REVIEWER_UNAVAILABLE even when the efficiency ladder
# still had stronger, perfectly healthy rungs to try.
#
# Under efficiency mode a launch failure therefore PROMOTES the task to the next
# stronger ELIGIBLE rung and the caller retries the failed role there. BOUNDED by
# construction: the promotion only ever looks ABOVE the rung it is standing on
# (efficiency.py select --after-rung), so every hop shortens the remaining ladder and
# the backstop is the last rung that can be tried; a rung that cannot even be BOUND
# is climbed past rather than halted on. When nothing is left, the caller halts as it
# always did — with the rungs it tried named in the terminal status.
#
# Returns 0 when a promotion happened (retry the role) and 1 when the caller must
# halt: efficiency off, no rung ladder for this task, a provider quota wall (which
# keeps its own reactive #28 terminal path — a stronger rung sits behind the same
# wall), or the ladder is out. It prints NOTHING on the first two, so a run without
# efficiency mode is byte-for-byte the halt it is today.
launch_escalate() {  # <role> <iteration> <why>
  local role="$1" iteration="${2:-}" why="${3:-}" rc=0
  [[ "$EFFICIENCY_ON" == "true" && -n "$TASK_RUNG" ]] || return 1
  [[ -z "$QUOTA_ROLE" ]] || return 1
  declare -F ralph_efficiency_launch_escalate_select >/dev/null 2>&1 || return 1
  echo "    ⚠ $role backend failed to LAUNCH on rung $TASK_RUNG ($why) — escalating instead of halting the batch."
  while :; do
    rc=0
    ralph_efficiency_launch_escalate_select "$TASK_COMPLEXITY" "$TARGET_REPO" \
      "$TASK_RUNG" "task $IDX" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      LAUNCH_ESCALATION_EXHAUSTED="true"
      LAUNCH_ESCALATION_ROLE="$role"
      LAUNCH_ESCALATION_RUNGS="$TASK_RUNGS_TRIED"
      LAUNCH_ESCALATION_REASON="${RALPH_ESCALATE_REASON:-no stronger rung is available}"
      echo "    no launchable rung left (tried: $TASK_RUNGS_TRIED) — $LAUNCH_ESCALATION_REASON" >&2
      return 1
    fi
    LAUNCH_ESCALATIONS=$((LAUNCH_ESCALATIONS + 1))
    TASK_LAUNCH_ESCALATIONS=$((TASK_LAUNCH_ESCALATIONS + 1))
    # Which ROLE could not launch where. The rung owns BOTH roles, so a promotion
    # rebinds the builder too even when it was the reviewer that failed — this trail
    # is what keeps the provenance honest about who actually did the work.
    TASK_LAUNCH_TRIGGERS="${TASK_LAUNCH_TRIGGERS:+$TASK_LAUNCH_TRIGGERS, }$role@$TASK_RUNG"
    TASK_RUNGS_TRIED="$TASK_RUNGS_TRIED -> $RALPH_ESCALATE_TO"
    LAUNCH_ESCALATION_RUNGS="$TASK_RUNGS_TRIED"
    ralph_efficiency_escalation_record "$RUN_DIR" "$TARGET_REPO" "batch-$TS" \
      "task $IDX" "$TASK_RUNG" "$RALPH_ESCALATE_TO" "$RALPH_ESCALATE_REASON" \
      "$iteration" "${role}_launch_failure"
    TASK_RUNG="$RALPH_ESCALATE_TO"
    if ! efficiency_apply_rung; then
      # The promotion named a rung this machine cannot launch either. Climb on from
      # IT — still bounded, because the ladder above it only ever gets shorter.
      echo "    ⚠ rung $TASK_RUNG is unusable here — $RUNG_BIND_ERROR; climbing further." >&2
      continue
    fi
    # The rung the task is ON changed, so the line every consumer prints (result
    # file, report, ledger) has to follow it, or the task is reported against a rung
    # it stopped using.
    EFFICIENCY_SUMMARY="$(ralph_efficiency_dispatch_summary)"
    echo "    escalated (launch failure): $RALPH_ESCALATE_FROM -> $TASK_RUNG (builder $BUILDER, reviewer $REVIEWER) — $RALPH_ESCALATE_REASON"
    return 0
  done
}

# ---- Efficiency mode (#59/#62) — opt-in; OFF leaves dispatch untouched ------
# --efficiency / RALPH_EFFICIENCY boot-validates the declarative profile here; each
# task's own rung is chosen in the task loop, from its complexity:<tier>. The
# selection resolved above stands unless that happens: a missing or rejected profile
# falls back to inert/off and the batch proceeds on the normal --builder/--reviewer
# path. Without the opt-in none of this runs at all.
EFFICIENCY_ON="false"
if declare -F ralph_efficiency_enabled >/dev/null 2>&1 && ralph_efficiency_enabled; then
  EFFICIENCY_ON="true"
  if ralph_efficiency_boot_validate "$TARGET_REPO"; then
    echo "efficiency mode: recognized, profile parsed — each task's complexity:<tier> decides its rung."
  else
    echo "efficiency mode: recognized but INERT (selection unchanged)."
  fi
else
  # Not opted in. Drop any decision inherited from a parent ralph process so this
  # run cannot be reported (in the ledger, the report or last-run.env) as governed
  # by a rung it never used.
  unset RALPH_EFFICIENCY_DISPATCH_STATE RALPH_EFFICIENCY_DISPATCH_NOTE \
        RALPH_EFFICIENCY_DISPATCH_TICKET RALPH_EFFICIENCY_DISPATCH_COMPLEXITY
fi

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
if [[ -n "${BATCH_LOCK_FILE:-}" ]]; then
  printf 'run=batch-%s pid=%s\n' "$TS" "$$" > "$BATCH_LOCK_FILE"
fi
RALPH_QUOTA_ARTIFACT="$RUN_DIR/provider-quota.env"
export RALPH_QUOTA_ARTIFACT
# Scratch index for WIP snapshots — lives in the run dir (outside the worktree, so it
# survives cleanup and never shows up in `git status`).
WIP_INDEX="$RUN_DIR/wip.index"

# ---- Preflight (repo contract) — block before any worktree/agent ------------
PREFLIGHT_OK="true"
if ! bash "$SCRIPT_DIR/preflight.sh" "$TARGET_REPO" "$RUN_DIR/preflight.md"; then
  PREFLIGHT_OK="false"
fi
if [[ -n "$PRIMER_WARNING" ]]; then
  {
    echo ""
    echo "## ⚠ Repo primer warning"
    echo ""
    echo "$PRIMER_WARNING"
  } >> "$RUN_DIR/preflight.md"
  echo "⚠⚠ $PRIMER_WARNING"
fi
if [[ "$PREFLIGHT_OK" != "true" ]]; then
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
# Trim a reviewer stdout log down to its findings block, for feeding back to the next
# builder attempt as {{PREVIOUS_REVIEW}}. Raw stdout is kept on disk untouched; this
# only changes what gets RE-SENT. On any doubt it copies the raw log — never drop
# reviewer feedback, which is correctness-critical to the iterate loop. (#41)
extract_review_findings() {  # <raw reviewer log> <dst feedback file>
  local raw="$1" dst="$2"
  [[ -s "$raw" ]] || { : > "$dst"; return 0; }
  python3 - "$raw" "$dst" <<'PY' 2>/dev/null || cp "$raw" "$dst" 2>/dev/null || true
import re, sys
raw_p, dst_p = sys.argv[1], sys.argv[2]
raw = open(raw_p, encoding="utf-8", errors="replace").read()
# Anchors. end: the LAST "VERDICT: X" line (template says write nothing after it).
# window: everything after the last echoed-template tail marker, if the backend echoed
# our prompt -- otherwise the template's OWN heading/VERDICT examples win the match.
# start: the earliest findings heading inside that window.
HEADINGS = ("### Must-fix issues", "### Should-fix issues", "### Evidence", "### Blocker report")
TEMPLATE_TAIL = "Write nothing after it."
MAX_BYTES = 64 * 1024
last = None
for last in re.finditer(r"^VERDICT:[ \t]*(PASS|FAIL|BLOCKED)[ \t]*$", raw, re.M):
    pass
if not last:
    raise SystemExit(1)                       # no verdict -> fall back to raw
cut = raw.rfind(TEMPLATE_TAIL, 0, last.start())
lo = cut + len(TEMPLATE_TAIL) if cut >= 0 else 0
window = raw[lo:last.start()]
hits = [h for h in (window.find(x) for x in HEADINGS) if h >= 0]
if not hits:
    raise SystemExit(1)                       # no findings block -> fall back to raw
out = raw[lo + min(hits):last.end()].strip() + "\n"
if len(out) > MAX_BYTES:
    out = out[:MAX_BYTES] + "\n[...truncated by harness...]\n"
open(dst_p, "w", encoding="utf-8").write(out)
PY
  [[ -s "$dst" ]] || cp "$raw" "$dst" 2>/dev/null || true
}

extract_usage() {  # <logfile> <sidecar>
  local log="$1" side="$2"
  [[ -s "$log" ]] || return 0
  rm -f "$side.shape-drift" 2>/dev/null || true
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
    # Not Claude JSON. Try codex JSONL (`codex exec --json`): usage rides the final
    # `turn.completed` event, and the assistant text lives in `item.completed` events
    # of type `agent_message`. Rebuild the plain-text log from those so the verdict
    # grep still works, exactly as the Claude branch does with `.result`.
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line[0] != "{":
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    usage = None
    texts = []
    for e in events:
        if not isinstance(e, dict):
            continue
        if e.get("type") == "turn.completed" and isinstance(e.get("usage"), dict):
            usage = e["usage"]                       # last one wins
        it = e.get("item")
        if e.get("type") == "item.completed" and isinstance(it, dict) \
                and it.get("type") == "agent_message" and isinstance(it.get("text"), str):
            texts.append(it["text"])
    if usage is None:
        # UNKNOWN JSON SHAPE. This is the dangerous case and the reason usage capture
        # can be on by default: if a CLI renames its events, leaving the raw JSON in
        # the log means the reviewer's `^VERDICT:` grep never matches -> every attempt
        # becomes REVIEWER_UNAVAILABLE and retries to MAX_ITERATIONS, on every run, with
        # a symptom that points nowhere near the cause.
        #
        # So salvage correctness and give up only on the metrics: walk the events for
        # any string under a "text" key at any depth (the generic assistant-text shape)
        # and rebuild a plain-text log from those. Metrics degrade to absent; the verdict
        # still parses. A loud stderr note names the shape so it gets fixed.
        if events:
            found = []
            def harvest(o, depth=0):
                if depth > 8 or len(found) > 200:
                    return
                if isinstance(o, dict):
                    t = o.get("text")
                    if isinstance(t, str) and t.strip():
                        found.append(t)
                    for v in o.values():
                        harvest(v, depth + 1)
                elif isinstance(o, list):
                    for v in o:
                        harvest(v, depth + 1)
            for e in events:
                harvest(e)
            if found:
                salvaged = "\n".join(found).rstrip() + "\n"
                if len(salvaged) > 256 * 1024:
                    salvaged = salvaged[: 256 * 1024] + "\n[...truncated by harness...]\n"
                open(log, "w", encoding="utf-8").write(salvaged)
                try:
                    open(side + ".shape-drift", "w", encoding="utf-8").write("1\n")
                except Exception:
                    pass
        sys.exit(0)   # no sidecar either way
    if texts:
        open(log, "w", encoding="utf-8").write("\n".join(texts).rstrip() + "\n")
    num = lambda x: x if isinstance(x, (int, float)) else None
    # Field names differ from both the OpenAI API and the Claude CLI -- see
    # TOKEN_ECONOMICS.md. cache_write is reported but unpopulated on this path
    # (always 0 even when cached_input_tokens grows), so it is recorded as-is and
    # must not be read as "nothing was cached".
    json.dump({
        "input": num(usage.get("input_tokens")),
        "output": num(usage.get("output_tokens")),
        "cache_read": num(usage.get("cached_input_tokens")),
        "cache_creation": num(usage.get("cache_write_input_tokens")),
        "reasoning_output": num(usage.get("reasoning_output_tokens")),
        "num_turns": None,
        "duration_ms": None,
        "total_cost_usd": None,
    }, open(side, "w", encoding="utf-8"), indent=2)
    sys.exit(0)
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
  if [[ -f "$side.shape-drift" ]]; then
    rm -f "$side.shape-drift"
    echo "ralph: WARNING: agent emitted JSON in an unrecognised shape: recovered the text so the verdict still parses, but usage metrics were NOT captured for this attempt. The backend CLI likely changed its event names - update extract_usage in batch-loop.sh (see .agents/ralph/references/TOKEN_ECONOMICS.md)." >&2
  fi
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
  # Reported-model capture MUST run before extract_usage: extract_usage rewrites
  # $logfile from raw JSON to plain text in place, so the model id has to be pulled
  # out of the untouched log first.
  ralph_capture_reported_model "$logfile" "${logfile%.*}.model.json"
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
  local prompt="$1" log="$2" i rc delay="$AGENT_RETRY_DELAY" provider pool
  provider="${BUILDER_PROVIDER:-$BUILDER}"
  pool="${RALPH_BUILDER_CREDENTIAL_POOL:-$provider}"
  if ralph_quota_pool_is_exhausted "$pool"; then QUOTA_ROLE="builder"; return 1; fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[RALPH_DRY_RUN] builder skipped." > "$log"
    printf 'batch dry-run task %s iter %s: %s\n' "$IDX" "$ITER" "$TITLE" >> "$WORKDIR/batch-dry-run.txt"
    printf '# Handoff (dry run) task %s iter %s\n- simulated change\n' "$IDX" "$ITER" > "$HANDOFF_PATH"
    return 0
  fi
  for (( i=1; i<=AGENT_ERROR_ATTEMPTS; i++ )); do
    ROUND_BUILDER_ATTEMPTS=$((ROUND_BUILDER_ATTEMPTS + 1))
    set +e; run_backend "$BUILDER_CMD" "$prompt" "$log"; rc=$?; set -e
    # #47: only a FAILED backend (rc!=0) can be a real quota wall; a successful builder
    # whose diff contains quota sample text must not self-trip the breaker.
    if [[ "$rc" -ne 0 ]] && ralph_detect_quota_exhaustion "$log" "$provider" "$pool"; then
      ROUND_BUILDER_ATTEMPTS=$((ROUND_BUILDER_ATTEMPTS - 1))
      ROUND_QUOTA_REJECTED=$((ROUND_QUOTA_REJECTED + 1))
      QUOTA_ROLE="builder"
      return 1
    fi
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
  local prompt="$1" out="$2" i rc v delay="$AGENT_RETRY_DELAY" provider pool
  provider="${REVIEWER_PROVIDER:-$REVIEWER}"
  pool="${RALPH_REVIEWER_CREDENTIAL_POOL:-$provider}"
  if ralph_quota_pool_is_exhausted "$pool"; then
    QUOTA_ROLE="reviewer"; REVIEWER_OUTCOME="QUOTA"; VERDICT=""; return 1
  fi
  for (( i=1; i<=AGENT_ERROR_ATTEMPTS; i++ )); do
    if [[ "$DRY_RUN" == "1" ]]; then
      { echo "### Must-fix issues"; echo "- none (dry run)"; echo ""; echo "VERDICT: PASS"; } > "$out"; rc=0
    else
      ROUND_REVIEWER_ATTEMPTS=$((ROUND_REVIEWER_ATTEMPTS + 1))
      set +e; run_backend "$REVIEWER_CMD" "$prompt" "$out"; rc=$?; set -e
      # #47: gate on a failed backend (see builder note above).
      if [[ "$rc" -ne 0 ]] && ralph_detect_quota_exhaustion "$out" "$provider" "$pool"; then
        ROUND_REVIEWER_ATTEMPTS=$((ROUND_REVIEWER_ATTEMPTS - 1))
        ROUND_QUOTA_REJECTED=$((ROUND_QUOTA_REJECTED + 1))
        QUOTA_ROLE="reviewer"; REVIEWER_OUTCOME="QUOTA"; VERDICT=""
        return 1
      fi
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
    echo "BUILDER=$BUILDER"
    echo "BUILDER_PROVIDER=$BUILDER_RESOLVED_PROVIDER"
    echo "BUILDER_MODEL=$BUILDER_RESOLVED_MODEL"
    echo "REVIEWER=$REVIEWER"
    echo "REVIEWER_PROVIDER=$REVIEWER_RESOLVED_PROVIDER"
    echo "REVIEWER_MODEL=$REVIEWER_RESOLVED_MODEL"
    echo "WIP_REF=${WIP_REF_LAST:-}"
    echo "WIP_NS=${WIP_REF_NS:-}/${TS:-}"
    echo "ROUND_USAGE_FILE=$RUN_DIR/round-usage.jsonl"
    echo "ORCHESTRATOR_BUDGET_TOKENS=${RALPH_BUDGET_TOKENS:-}"
    echo "ORCHESTRATOR_BUDGET_STOP_PCT=${RALPH_BUDGET_STOP_PCT:-100}"
    echo "ORCHESTRATOR_BUDGET_THRESHOLD_TOKENS=${RALPH_BUDGET_THRESHOLD_TOKENS:-}"
    echo "ORCHESTRATOR_BUDGET_OBSERVED_TOKENS=${RALPH_BUDGET_OBSERVED_TOKENS:-0}"
    echo "ORCHESTRATOR_BUDGET_UNKNOWN_ROUNDS=${RALPH_BUDGET_UNKNOWN_ROUNDS:-0}"
    if [[ -n "${EFFICIENCY_SUMMARY:-}" ]]; then
      ralph_env_assignment EFFICIENCY_STATE "${RALPH_EFFICIENCY_DISPATCH_STATE:-}"
      ralph_env_assignment EFFICIENCY_COMPLEXITY "${RALPH_EFFICIENCY_DISPATCH_COMPLEXITY:-}"
      ralph_env_assignment EFFICIENCY_RUNG "${RALPH_EFFICIENCY_SELECT_RUNG:-}"
      ralph_env_assignment EFFICIENCY_REASON "${RALPH_EFFICIENCY_SELECT_REASON:-}"
      ralph_env_assignment EFFICIENCY_PAUSE_UNTIL "${RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL:-}"
    fi
    # #75 — written only when a launch failure actually escalated, so a run without
    # efficiency mode gains no new fields at all.
    if [[ "${LAUNCH_ESCALATIONS:-0}" -gt 0 || "${LAUNCH_ESCALATION_EXHAUSTED:-false}" == "true" ]]; then
      ralph_env_assignment LAUNCH_ESCALATIONS "${LAUNCH_ESCALATIONS:-0}"
      ralph_env_assignment LAUNCH_ESCALATION_RUNGS "${LAUNCH_ESCALATION_RUNGS:-}"
      ralph_env_assignment LAUNCH_ESCALATION_ROLE "${LAUNCH_ESCALATION_ROLE:-}"
      ralph_env_assignment LAUNCH_ESCALATION_REASON "${LAUNCH_ESCALATION_REASON:-}"
    fi
    ralph_env_assignment PROVIDER_QUOTA_PROVIDER "${RALPH_QUOTA_PROVIDER:-}"
    ralph_env_assignment PROVIDER_QUOTA_CREDENTIAL_POOL "${RALPH_QUOTA_CREDENTIAL_POOL:-}"
    ralph_env_assignment PROVIDER_QUOTA_SCOPE "${RALPH_QUOTA_SCOPE:-}"
    ralph_env_assignment PROVIDER_QUOTA_OBSERVED_AT "${RALPH_QUOTA_OBSERVED_AT:-}"
    ralph_env_assignment PROVIDER_QUOTA_RESET_AT "${RALPH_QUOTA_RESET_AT:-}"
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
  echo "PRIMER_STATUS=$PRIMER_STATUS"
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
  echo "RALPH_ORCHESTRATOR_BUDGET_TOKENS=${RALPH_ORCHESTRATOR_BUDGET_TOKENS:-}"
  echo "RALPH_ORCHESTRATOR_STOP_PCT=${RALPH_ORCHESTRATOR_STOP_PCT:-100}"
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
if [[ "$EFFICIENCY_ON" == "true" ]]; then
  echo "  efficiency:    ON (${RALPH_EFFICIENCY_STATE:-unknown} profile) — a task with a complexity:<tier> overrides the two lines above"
  echo "                 a rung whose backend fails to LAUNCH is promoted to the next stronger eligible rung (bounded by the ladder), not halted on"
fi
echo "  check:         $CHECK_CMD"
echo "  verify:        ${VERIFY_CMD:-(none)}"
if [[ "$PRIMER_STATUS" == "deliberate-opt-out" ]]; then
  echo "  primer:        (none; deliberate opt-out via RALPH_PRIMER_OPTOUT=1)"
else
  echo "  primer:        ${PRIMER_FILE:-(none)}"
fi
echo "  max attempts/task: $MAX_ITERATIONS   agent-error retries: $AGENT_RETRIES   resume: $RESUMING"
echo "  auto-approve builder: $AUTO_APPROVE_BUILDER   stop-on-fail: $STOP_ON_FAIL"
echo "  token budget:  ${RALPH_ORCHESTRATOR_BUDGET_TOKENS:-(off)}   stop pct: ${RALPH_ORCHESTRATOR_STOP_PCT:-100}"
echo "  preview:       $PREVIEW_ENABLED${RALPH_PREVIEW_URL:+  (url after batch: $RALPH_PREVIEW_URL)}"
echo "  artifacts:     $RUN_DIR"
echo "═══════════════════════════════════════════════════════"
if [[ -n "$PRIMER_WARNING" ]]; then
  echo "  ⚠⚠ $PRIMER_WARNING"
fi
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
QUOTA_ROLE=""
AGENT_ERROR_EXIT=""
HALTED_TASK=""
BUDGET_REACHED="false"
EFFICIENCY_PAUSED="false"   # #62: a bounded PAUSE from ralph_efficiency_select
EFFICIENCY_PAUSED_TASK=""
EFFICIENCY_SUMMARY=""       # per-task line for the result file / report (empty when off)
# #75 launch-failure escalation. All inert unless efficiency mode promoted a task off
# an unlaunchable rung, so the no-efficiency run records and prints exactly what it
# does today.
LAUNCH_ESCALATIONS=0          # promotions in this batch (all tasks)
LAUNCH_ESCALATION_EXHAUSTED="false"   # the ladder ran out => own terminal status
LAUNCH_ESCALATION_ROLE=""     # role whose backend could not launch anywhere
LAUNCH_ESCALATION_RUNGS=""    # rungs tried for the task that halted, in order
LAUNCH_ESCALATION_REASON=""
TASK_RUNG=""; TASK_RUNGS_TRIED=""; TASK_COMPLEXITY=""
TASK_LAUNCH_ESCALATIONS=0; TASK_LAUNCH_TRIGGERS=""
RALPH_BUDGET_CONFIGURED="false"; RALPH_BUDGET_REACHED="false"
RALPH_BUDGET_TOKENS="${RALPH_ORCHESTRATOR_BUDGET_TOKENS:-}"
RALPH_BUDGET_STOP_PCT="${RALPH_ORCHESTRATOR_STOP_PCT:-100}"
RALPH_BUDGET_THRESHOLD_TOKENS=""; RALPH_BUDGET_OBSERVED_TOKENS="0"
RALPH_BUDGET_UNKNOWN_ROUNDS="0"

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
  # Re-read the persisted aggregate immediately before dispatch. This matters on
  # --resume as well as after an ordinarily completed prior round.
  set +e; ralph_orchestrator_budget_refresh "$RUN_DIR"; BUDGET_RC=$?; set -e
  if [[ "$BUDGET_RC" -eq 2 ]]; then die "Invalid orchestrator budget configuration."; fi
  if [[ "$BUDGET_RC" -eq 0 ]]; then BUDGET_REACHED="true"; break; fi
  ATTEMPTED=$((ATTEMPTED + 1))
  TASK_FILE="$TASKS_DIR/$FN"

  echo ""
  echo "── Task $IDX/$TASK_TOTAL: $TITLE  (up to $MAX_ITERATIONS attempt(s)) ──"

  # One task's rung — and its launch-failure escalation trail (#75) — must never leak
  # into the next, or a later task would be escalated off a rung it never ran on.
  TASK_RUNG=""; TASK_RUNGS_TRIED=""; TASK_COMPLEXITY=""
  TASK_LAUNCH_ESCALATIONS=0; TASK_LAUNCH_TRIGGERS=""

  # Per-task efficiency rung (#62) — opt-in only. With the mode off this block never
  # executes, so dispatch below is exactly today's --builder/--reviewer path. With it
  # on, the task's own complexity:<tier> picks the rung; anything unusable (no tier,
  # no valid profile) is INERT and leaves the operator's selection alone.
  if [[ "$EFFICIENCY_ON" == "true" ]]; then
    efficiency_restore_defaults   # one task's rung must never leak into the next
    TASK_COMPLEXITY="$(ralph_efficiency_complexity_from_text "$(cat "$TASK_FILE")")"
    EFFICIENCY_RC=0
    ralph_efficiency_dispatch_select "$TASK_COMPLEXITY" "$TARGET_REPO" "task $IDX" \
      || EFFICIENCY_RC=$?
    ralph_efficiency_dispatch_record "$RUN_DIR"
    EFFICIENCY_SUMMARY="$(ralph_efficiency_dispatch_summary)"
    if [[ "$EFFICIENCY_RC" -eq 3 ]]; then
      # Bounded PAUSE (#61) handled #29-style: this task was never dispatched, so
      # un-count the attempt and stop the batch CLEANLY. Everything already earned —
      # committed tasks, their usage lines, the artifacts — stays exactly as it is.
      ATTEMPTED=$((ATTEMPTED - 1))
      EFFICIENCY_PAUSED="true"; EFFICIENCY_PAUSED_TASK="$IDX"
      echo "    ⏸ efficiency PAUSE before dispatch — $RALPH_EFFICIENCY_SELECT_REASON"
      break
    fi
    if [[ "$EFFICIENCY_RC" -eq 0 ]]; then
      TASK_RUNG="$RALPH_EFFICIENCY_SELECT_RUNG"
      TASK_RUNGS_TRIED="$TASK_RUNG"
      echo "    $EFFICIENCY_SUMMARY"
      # A rung whose backends are not installed here has already failed to launch
      # (#75): escalate past it rather than killing the run. Only when the ladder has
      # nothing launchable left does the task halt — and then it halts on the same
      # HALTED path as any other backend outage, below.
      if ! efficiency_apply_rung; then
        if ! launch_escalate "builder" "0" "$RUNG_BIND_ERROR"; then
          AGENT_ERROR_ROLE="builder"; HALTED_TASK="$IDX"
        fi
      fi
    fi
  fi

  HANDOFF_PATH="$WORKDIR/.agent-handoff.md"
  RESULT_FILE="$RUN_DIR/task-$IDX-result.md"
  HEAD_BEFORE="$(git -C "$WORKDIR" rev-parse HEAD)"

  # Per-task retry loop: builder -> check -> reviewer, feeding FAIL feedback back
  # to the builder, until check passes AND the reviewer says PASS, or we run out
  # of attempts. Mirrors `ralph review`, but the task is committed once at the end.
  TASK_STATUS="FAIL"; ITERS_USED=0; VERIFY_STATUS=""
  ROUND_BUILDER_ATTEMPTS=0; ROUND_REVIEWER_ATTEMPTS=0; ROUND_QUOTA_REJECTED=0
  PREV_REVIEW=""; PREV_CHECK=""; PREV_VERIFY=""
  # Final-iteration artifacts (the result file points at these).
  DIFF_PATCH="$RUN_DIR/task-$IDX-diff.patch"
  CHECK_LOG="$RUN_DIR/task-$IDX-check.log"
  VERIFY_LOG="$RUN_DIR/task-$IDX-verify.log"
  HANDOFF_SNAP="$RUN_DIR/task-$IDX-handoff.md"
  REVIEWER_OUT="$RUN_DIR/task-$IDX-reviewer.md"

  for ITER in $(seq 1 "$MAX_ITERATIONS"); do
    # #75: a dispatch-time rung that could not be bound, and that escalation could not
    # rescue, has already halted this task — launch nothing, and fall through to the
    # ordinary HALTED handling below.
    [[ -z "$AGENT_ERROR_ROLE" ]] || break
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
    # Trimmed findings actually re-sent to the next builder attempt (#41). Kept as its
    # own artifact so what the builder saw is auditable next to the raw stdout.
    ITER_REVIEWER_FB="$RUN_DIR/task-$IDX-iter-$ITER-reviewer-feedback.md"

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
    BUILDER_RC=0
    # The loop body is one builder LAUNCH. It runs exactly once unless #75 escalation
    # promotes the task off an unlaunchable rung, in which case the same attempt is
    # re-launched on the stronger rung (bounded by the ladder) — so without efficiency
    # mode this is byte-for-byte the single launch it has always been.
    while :; do
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
      [[ "$BUILDER_RC" -eq 0 ]] && break
      launch_escalate "builder" "$ITER" \
        "exit ${AGENT_ERROR_EXIT:-?} on all $AGENT_ERROR_ATTEMPTS attempt(s)" || break
      # Keep the failed rung's log: the new rung writes its own, so an operator can see
      # both what did not launch and what ran instead.
      BUILDER_LOG="$RUN_DIR/task-$IDX-iter-$ITER-builder-rung-$TASK_RUNG.log"
    done
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
    # As with the builder above: one reviewer LAUNCH, repeated only when #75 promotes
    # the task off a reviewer backend that could not run at all.
    while :; do
      echo "    reviewer ($REVIEWER, read-only)..."
      run_reviewer_attempt "$REVIEWER_PROMPT_R" "$ITER_REVIEWER_OUT" || true
      [[ "$REVIEWER_OUTCOME" == "ERROR" ]] || break
      launch_escalate "reviewer" "$ITER" \
        "exit ${AGENT_ERROR_EXIT:-?} or no VERDICT on all $AGENT_ERROR_ATTEMPTS attempt(s)" || break
      ITER_REVIEWER_OUT="$RUN_DIR/task-$IDX-iter-$ITER-reviewer-rung-$TASK_RUNG.md"
    done

    # Point the canonical per-task artifacts at this (latest) attempt.
    cp "$ITER_CHECK_LOG" "$CHECK_LOG" 2>/dev/null || true
    cp "$ITER_DIFF" "$DIFF_PATCH" 2>/dev/null || true
    cp "$ITER_HANDOFF" "$HANDOFF_SNAP" 2>/dev/null || true
    cp "$ITER_REVIEWER_OUT" "$REVIEWER_OUT" 2>/dev/null || true

    if [[ "$REVIEWER_OUTCOME" == "ERROR" || "$REVIEWER_OUTCOME" == "QUOTA" ]]; then
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
    # Send the reviewer's FINDINGS, not its raw stdout: argv/stdin CLIs like codex echo
    # the whole input prompt (including the builder's own git diff) before replying, so
    # re-sending the log verbatim round-trips 60-85% of a retry prompt back to the
    # builder. Falls back to the raw log if no findings block is recognisable, so
    # feedback is never silently dropped. (#41)
    extract_review_findings "$ITER_REVIEWER_OUT" "$ITER_REVIEWER_FB"
    PREV_REVIEW="$ITER_REVIEWER_FB"; PREV_CHECK="$ITER_CHECK_LOG"
    [[ "$ITER" -lt "$MAX_ITERATIONS" ]] && echo "    not passing — retrying with feedback"
  done

  ralph_round_usage_line "$RUN_DIR" "$IDX" "$ROUND_BUILDER_ATTEMPTS" \
    "$ROUND_REVIEWER_ATTEMPTS" "$ROUND_QUOTA_REJECTED" "$TARGET_REPO" "batch-$TS"

  # A provider failure retains its reactive #28 terminal state. Otherwise tally
  # the just-flushed round before deciding whether another task may be dispatched.
  if [[ -z "$AGENT_ERROR_ROLE" ]]; then
    set +e; ralph_orchestrator_budget_refresh "$RUN_DIR"; BUDGET_RC=$?; set -e
    if [[ "$BUDGET_RC" -eq 2 ]]; then die "Invalid orchestrator budget configuration."; fi
    [[ "$BUDGET_RC" -eq 0 ]] && BUDGET_REACHED="true"
  fi

  # Unrecoverable agent (builder/reviewer) ERROR → halt: do not commit, do not
  # count this task as PASS/FAIL.
  if [[ -n "$AGENT_ERROR_ROLE" ]]; then
    if [[ "$LAUNCH_ESCALATION_EXHAUSTED" == "true" ]]; then
      echo "Task $IDX HALTED — no launchable rung left for the $AGENT_ERROR_ROLE backend (rungs tried: $LAUNCH_ESCALATION_RUNGS)."
    else
      echo "Task $IDX HALTED — $AGENT_ERROR_ROLE backend unavailable (ERROR after $AGENT_ERROR_ATTEMPTS attempts)."
    fi
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
    echo "- PR provenance (paste into the PR): builder: $BUILDER (provider: $BUILDER_RESOLVED_PROVIDER, model: $BUILDER_RESOLVED_MODEL), reviewer: $REVIEWER (provider: $REVIEWER_RESOLVED_PROVIDER, model: $REVIEWER_RESOLVED_MODEL), iterations: $ITERS_USED"
    [[ -n "$EFFICIENCY_SUMMARY" ]] && echo "- $EFFICIENCY_SUMMARY"
    [[ "$TASK_LAUNCH_ESCALATIONS" -gt 0 ]] && echo "- Launch-failure escalation (#75): rungs tried $TASK_RUNGS_TRIED ($TASK_LAUNCH_ESCALATIONS escalation(s); could not launch: $TASK_LAUNCH_TRIGGERS — promoted rather than retried)"
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

  if [[ "$BUDGET_REACHED" == "true" ]]; then
    echo "Orchestrator token budget reached after task $IDX; no next round will be dispatched."
    break
  fi

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
if [[ "$PREVIEW_ENABLED" == "true" && -z "$AGENT_ERROR_ROLE" && "$BUDGET_REACHED" != "true" \
      && "$EFFICIENCY_PAUSED" != "true" ]]; then
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
  if [[ -n "$QUOTA_ROLE" ]]; then OUTCOME="PROVIDER_QUOTA_EXHAUSTED"
  elif [[ "$LAUNCH_ESCALATION_EXHAUSTED" == "true" ]]; then
    # #75: efficiency mode climbed the whole ladder and every rung failed to LAUNCH.
    # Its own terminal state, so a total tooling outage is never confused with the
    # single-backend halt below (which is what a run WITHOUT a rung ladder still gets).
    OUTCOME="LAUNCH_ESCALATION_EXHAUSTED"
  elif [[ "$AGENT_ERROR_ROLE" == "reviewer" ]]; then OUTCOME="REVIEWER_UNAVAILABLE"
  else OUTCOME="BUILDER_UNAVAILABLE"; fi
elif [[ "$EFFICIENCY_PAUSED" == "true" ]]; then
  # Not a failure and not a quota wall: efficiency mode found no eligible rung, so the
  # batch stopped before dispatching the next task. Its own terminal status (#62).
  OUTCOME="EFFICIENCY_PAUSED"
elif [[ "$BUDGET_REACHED" == "true" ]]; then
  OUTCOME="ORCHESTRATOR_BUDGET_REACHED"
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
  if [[ "$RALPH_BUDGET_CONFIGURED" == "true" ]]; then
    echo "- Orchestrator token budget: $RALPH_BUDGET_TOKENS at $RALPH_BUDGET_STOP_PCT% (threshold: $RALPH_BUDGET_THRESHOLD_TOKENS; observed: $RALPH_BUDGET_OBSERVED_TOKENS; unknown rounds counted as zero: $RALPH_BUDGET_UNKNOWN_ROUNDS)"
  else
    echo "- Orchestrator token budget: off"
  fi
  if [[ "$PRIMER_STATUS" == "deliberate-opt-out" ]]; then
    echo "- Repo primer: deliberately disabled (RALPH_PRIMER_OPTOUT=1)"
  elif [[ -n "$PRIMER_WARNING" ]]; then
    echo "- Repo primer: unavailable ($PRIMER_STATUS)"
  else
    echo "- Repo primer: $PRIMER_FILE"
  fi
  echo "- Tasks attempted: $ATTEMPTED of $TASK_TOTAL (completed: $COMPLETED, failed: $FAILED, blocked: $BLOCKED_COUNT, skipped-on-resume: $SKIPPED)"
  if [[ "$PREVIEW_RAN" == "true" ]]; then
    echo "- Preview: ${PREVIEW_UP_OK:+up=$PREVIEW_UP_OK }${E2E_OK:+e2e=$E2E_OK }URL=$RALPH_PREVIEW_URL"
  elif [[ -n "$AGENT_ERROR_ROLE" ]]; then
    echo "- Preview: skipped (batch halted on $AGENT_ERROR_ROLE error)"
  elif [[ "$BUDGET_REACHED" == "true" ]]; then
    echo "- Preview: skipped (orchestrator budget reached)"
  elif [[ "$EFFICIENCY_PAUSED" == "true" ]]; then
    echo "- Preview: skipped (efficiency pause)"
  else
    echo "- Preview: disabled"
  fi
  if [[ "$EFFICIENCY_PAUSED" == "true" ]]; then
    echo ""
    echo "## ⏸ Efficiency pause"
    echo ""
    echo "- Paused before dispatching task $EFFICIENCY_PAUSED_TASK (complexity: ${RALPH_EFFICIENCY_DISPATCH_COMPLEXITY:-unknown})"
    echo "- Reason: ${RALPH_EFFICIENCY_SELECT_REASON:-no reason reported}"
    echo "- Retry after: ${RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL:-unknown} (${RALPH_EFFICIENCY_SELECT_PAUSE_SECONDS:-?}s)"
    echo "- That task was NOT dispatched; every completed task is committed and its"
    echo "  usage line flushed. Resume after the retry time (completed tasks are skipped):"
    echo "    ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --resume"
  elif [[ -n "$EFFICIENCY_SUMMARY" ]]; then
    echo "- Last task $EFFICIENCY_SUMMARY"
  fi
  if [[ -n "$PRIMER_WARNING" ]]; then
    echo ""
    echo "## ⚠ Repo primer warning"
    echo ""
    echo "$PRIMER_WARNING"
  fi
  if [[ "$LAUNCH_ESCALATIONS" -gt 0 ]]; then
    echo ""
    echo "## ⚙ Launch-failure escalations (#75)"
    echo ""
    echo "- $LAUNCH_ESCALATIONS rung promotion(s) because a backend could not LAUNCH (not because a"
    echo "  reviewer failed a task). Last trail: ${LAUNCH_ESCALATION_RUNGS:-(none)}"
    echo "- Per-escalation records: $RUN_DIR/escalations.jsonl (and the ledger, as \`event\` lines)"
  fi
  if [[ -n "$AGENT_ERROR_ROLE" && "$LAUNCH_ESCALATION_EXHAUSTED" == "true" ]]; then
    echo ""
    echo "## ⚠ Halted: no launchable rung left ($AGENT_ERROR_ROLE)"
    echo ""
    echo "Efficiency mode climbed the whole rung ladder for task $HALTED_TASK and the"
    echo "**$AGENT_ERROR_ROLE** backend failed to LAUNCH on every rung tried:"
    echo "\`$LAUNCH_ESCALATION_RUNGS\` (up to the backstop). Escalation stopped because:"
    echo "$LAUNCH_ESCALATION_REASON"
    echo ""
    echo "That is a tooling outage across the ladder, NOT a task failure: no builder"
    echo "attempt was consumed and no error output was fed back as feedback. Fix or"
    echo "re-authenticate those backends (or widen the tier in the efficiency profile),"
    echo "then RESUME — already-PASSed tasks stay committed and are skipped:"
    echo "  ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --efficiency --resume"
  elif [[ -n "$AGENT_ERROR_ROLE" ]]; then
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
if [[ "$OUTCOME" == "READY_FOR_HUMAN_REVIEW" ]]; then
  echo "  Agents: builder=$BUILDER (provider=$BUILDER_RESOLVED_PROVIDER, model=$BUILDER_RESOLVED_MODEL); reviewer=$REVIEWER (provider=$REVIEWER_RESOLVED_PROVIDER, model=$REVIEWER_RESOLVED_MODEL)"
fi
echo "───────────────────────────────────────────────────────"
echo "  Branch:    $BRANCH (NOT merged)"
echo "  Worktree:  $WORKDIR"
echo "  Report:    $REPORT"
if [[ "$LAUNCH_ESCALATIONS" -gt 0 ]]; then
  echo "  Launch-failure escalations: $LAUNCH_ESCALATIONS (rungs tried: $LAUNCH_ESCALATION_RUNGS)"
fi
if [[ -n "$AGENT_ERROR_ROLE" ]]; then
  agent_name="$([[ "$AGENT_ERROR_ROLE" == reviewer ]] && echo "$REVIEWER" || echo "$BUILDER")"
  if [[ -n "$QUOTA_ROLE" ]]; then
    echo "  ⏸ PROVIDER_QUOTA_EXHAUSTED — $QUOTA_ROLE provider '$RALPH_QUOTA_PROVIDER' paused${RALPH_QUOTA_RESET_AT:+ until $RALPH_QUOTA_RESET_AT}."
    echo "  After the provider recovers, resume (completed tasks are skipped):"
  elif [[ "$LAUNCH_ESCALATION_EXHAUSTED" == "true" ]]; then
    echo "  ⚠ Halted: no launchable rung left — the $AGENT_ERROR_ROLE backend failed to LAUNCH on every rung tried: $LAUNCH_ESCALATION_RUNGS."
    echo "  $LAUNCH_ESCALATION_REASON"
    echo "  Fix/re-authenticate those backends (or widen the tier), then resume (completed tasks are skipped):"
  else
    echo "  ⚠ Halted: $AGENT_ERROR_ROLE backend ($agent_name) unavailable after $AGENT_ERROR_ATTEMPTS attempts (last exit ${AGENT_ERROR_EXIT:-?})."
    echo "  Re-authenticate that CLI, then resume (completed tasks are skipped):"
  fi
  echo "    ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --builder $BUILDER --reviewer $REVIEWER --resume"
  echo "═══════════════════════════════════════════════════════"
  exit 4
fi
if [[ "$EFFICIENCY_PAUSED" == "true" ]]; then
  echo "  ⏸ EFFICIENCY_PAUSED — $RALPH_EFFICIENCY_SELECT_REASON"
  echo "  Task $EFFICIENCY_PAUSED_TASK was NOT dispatched. Completed tasks are committed, their"
  echo "  usage is flushed, and every artifact is preserved in $RUN_DIR."
  echo "  Retry after ${RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL:-the pool recovers} (completed tasks are skipped):"
  echo "    ralph batch --repo \"$TARGET_REPO\" --plan \"$PLAN\" --efficiency --resume"
  echo "═══════════════════════════════════════════════════════"
  exit 5
fi
if [[ "$BUDGET_REACHED" == "true" ]]; then
  echo "  ⏹ ORCHESTRATOR_BUDGET_REACHED — budget=$RALPH_BUDGET_TOKENS tokens pct=$RALPH_BUDGET_STOP_PCT observed=$RALPH_BUDGET_OBSERVED_TOKENS tokens."
  if [[ "$RALPH_BUDGET_UNKNOWN_ROUNDS" -gt 0 ]]; then
    echo "  Note: $RALPH_BUDGET_UNKNOWN_ROUNDS round(s) had unknown usage and counted as 0; no token values were fabricated."
  fi
  echo "  Worktree and artifacts are preserved; no next round was dispatched."
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
