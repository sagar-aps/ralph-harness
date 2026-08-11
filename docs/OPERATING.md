# Operating the harness — every mode and flag in one place

This is the **operator reference**: for each mode/flag, what it is, **how to turn it on**,
its **default**, and **how it composes** with the others. Everything here was read off the
merged source in this repo (`bin/ralph`, `.agents/ralph/*.sh|*.py`) — file/line pointers are
given so you can re-verify rather than trust the prose.

Related docs: [modes.md](modes.md) (which *setup* to pick — unmanaged vs managed),
[architecture.md](architecture.md) (the five roles), [agent-operator.md](agent-operator.md)
(driving the harness from a coding agent), and the [README](../README.md) (tutorials).

---

## 1. Defaults / opt-in at a glance

**Nothing in the "opt-in" half of this table does anything until you enable it.** That is the
contract: an unset flag means the code path does not run.

| Mode / flag | Enable with | Default | Scope |
|---|---|---|---|
| **Opt-in (OFF unless you ask)** | | | |
| Efficiency mode | `--efficiency` or `RALPH_EFFICIENCY=1\|true\|yes\|on` | **OFF** | `review`, `batch` |
| Efficiency profile path | `--efficiency-profile <p>` / `RALPH_EFFICIENCY_PROFILE` | `<repo>/.agents/ralph/efficiency.json` | `review`, `batch`, `explain` |
| Auto-escalate | `--auto-escalate` or `RALPH_AUTO_ESCALATE=1\|true\|yes\|on` | **OFF** | `review` **only** |
| Per-rung budget | `--escalate-iterations <n>` / `RALPH_ESCALATE_ITERATIONS` | `3` (only used when auto-escalate is on) | `review` |
| Orchestrator token ceiling | `RALPH_ORCHESTRATOR_BUDGET_TOKENS` (+ `RALPH_ORCHESTRATOR_STOP_PCT`) | **unset = off** (stop pct `100`) | `batch` **only** |
| Custom pricing table | `RALPH_PRICING_FILE` | ships `.agents/ralph/pricing.json` | `ralph report` |
| Driver usage in the ledger | `ralph log-usage --role driver --pool <p> --usage-json <f>` | **nothing logs the driver automatically** | `ralph log-usage` (§11.1) |
| Custom quota-exhaustion regex | `RALPH_QUOTA_REGEX` | built-in ERE (see §9) | `batch` |
| Credential-pool identity | `RALPH_BUILDER_CREDENTIAL_POOL` / `RALPH_REVIEWER_CREDENTIAL_POOL` | provider name | `batch` |
| Identity wrapper | `ralph.target.json` `identity.enabled` / `RALPH_IDENTITY_WRAPPER` / `.agents/ralph/identity.sh` | **no marker → ambient `gh`** | Manager / Orchestrator |
| Cron/orchestrator driver | `RALPH_CRON_DRIVER` (or `_PROVIDER`/`_MODEL`/`_EFFORT`) | `RALPH_CRON_DRIVER_DEFAULT` → `$DEFAULT_AGENT` → `codex` | orchestrator loop |
| Usage-aware driver choice | `ralph pick-driver` (+ `--candidates` / `RALPH_CRON_DRIVER_CANDIDATES`) | **nothing picks the driver by usage automatically** — fails open to the `RALPH_CRON_DRIVER` default | `ralph pick-driver` (§4.2) |
| Manager role | `ralph init-target` installs it; boot `/manager` in the target repo | not booted | target repo session |
| Verify gate | `--verify <cmd>` / `ralph.target.json` `.verify` | empty = disabled | `batch` |
| Primer | `--primer <file>` / `ralph.target.json` `.primer` | unset (soft warning) | `batch` |
| Primer opt-out | `RALPH_PRIMER_OPTOUT=1` | off (warning shown) | `batch` |
| Unattended builder | `--auto-approve-builder` | `false` | `batch` |
| Stop at first failure | `--stop-on-fail` | `false` | `batch` |
| Resume a halted run | `--resume` | `false` | `batch` |
| Detached run | `--detach` | `false` | `batch` |
| Concurrent batch override | `--allow-concurrent` / `RALPH_ALLOW_CONCURRENT=1` | **OFF**; one live batch per target | `batch` |
| Dirty target allowed | `--allow-dirty` / `ALLOW_DIRTY=true` | `false` | `review`, `batch` |
| Branch in place (no worktree) | `--no-worktree` / `USE_WORKTREE=false` | worktree **on** | `review` |
| Skip preflight | `--no-preflight` / `--skip-preflight` / `PREFLIGHT_SKIP=true` | preflight runs | `build`, `review`, `batch` |
| Skip `config.local.sh` | `RALPH_NO_LOCAL_CONFIG=1` | sourced when present | all loops |
| Skip update check | `RALPH_SKIP_UPDATE_CHECK=1` | check runs | CLI |
| **On by default (opt-OUT)** | | | |
| Per-attempt usage capture | on; disable with `RALPH_USAGE=0` | **ON** | `batch` |
| Ledger (`.ralph/ledger.jsonl`) | written automatically | **ON** | `batch` rounds; `review` escalation events |
| Preflight (repo contract) | `ralph.target.json` `preflight` block | runs when configured + enabled | `build`, `review`, `batch` |
| Floor guard | `source .agents/ralph/floor-guard.sh`; disable with `RALPH_FLOOR_GUARD=off` | **armed once sourced** | orchestrator shell |
| WIP snapshots (detached) | `RALPH_SNAPSHOT_INTERVAL` seconds | `60` (`0` disables) | `batch --detach` |
| Agent-ERROR retries | `RALPH_AGENT_RETRIES` / `RALPH_AGENT_RETRY_DELAY` | `2` retries, `2`s backoff (doubling) | `batch` |
| Iterations per task/story | `--max-iterations <n>` / `MAX_ITERATIONS` | `5` | `review`, `batch` |
| Check command | `--check <cmd>` / `CHECK_CMD` / `ralph.target.json` `.check` | `./scripts/check.sh` | `review`, `batch` |
| Verdict regex | `--verdict-regex` / `VERDICT_REGEX` | `^VERDICT: (PASS\|FAIL)` (`batch` also allows `BLOCKED`) | `review`, `batch` |
| Builder / reviewer backend | `--builder` / `--reviewer` (or `BUILDER` / `REVIEWER`) | `opencode` / `claude` | `review`, `batch` |
| Website preview + e2e | `ralph.target.json` `preview.enabled`; force with `--preview` / `--no-preview` | target config decides | `review`, end of `batch` |

---

## 2. Roles vs backends (the base layer everything else modifies)

A **role** is a job (builder, reviewer, cron driver). A **backend** is a concrete command.
Any backend can fill any role.

- **Shipped backends** (`.agents/ralph/agents.sh`): `claude`, `codex`, `codex-write`,
  `codex-readonly`, `droid`, `opencode`, `opencode-z`, plus `cxb` / `cxr` if you define
  `AGENT_CXB_CMD` / `AGENT_CXR_CMD`.
- **Any new backend, no code change**: define `AGENT_<NAME>_CMD` (name uppercased, dashes →
  underscores) in `config.local.sh`, then `--builder <name>`. The template either contains
  `{prompt}` (a quoted prompt-file path is substituted) or reads the prompt from stdin.
- **Defaults**: `BUILDER=opencode`, `REVIEWER=claude`
  (`review-loop.sh:105-106`, `batch-loop.sh:129-130`).
- **Codex hardening is unconditional**: every resolved `codex exec` command gets
  `-c 'mcp_servers={}' --disable apps` re-applied at resolution time, so an old local
  override cannot restore MCP/app connector write paths (`agents.sh:ralph_codex_disable_connectors`).

### Normalized selection: `{provider, model, effort}`

Instead of hand-writing command strings:

```bash
ralph batch --repo <t> --plan <p> \
  --builder-provider codex --builder-effort high \
  --reviewer-provider zai  --reviewer-model glm-4.5-air
```

- Providers: `codex`, `claude`, `zai`/`zlaude`, `opencode`, `droid`, or any custom wrapper
  backend name.
- `--profile cheap|balanced|max` (`RALPH_PROFILE`) fills only the knobs you left unset:
  `cheap` = builder codex/low + reviewer codex/low; `balanced` = builder codex/medium +
  reviewer codex/low; `max` = builder codex/high + reviewer codex/medium
  (`agents.sh:ralph_apply_profile`).
- Effort is `low|medium|high`. **Only codex maps it** (`-c model_reasoning_effort=…`);
  claude effort is deferred, and zai/opencode/droid ignore it (`agents.sh:ralph_effort_flag`).
- The reviewer is composed read-only where the CLI supports it (codex gets
  `--sandbox read-only`).
- **This is opt-in machinery**: with no provider/model/effort/profile set,
  `ralph_resolve_role_agents` returns immediately and the legacy `--builder <name>` path is
  byte-for-byte unchanged.

### Configuring it: `config.local.sh`

`cp .agents/ralph/config.local.sh.example .agents/ralph/config.local.sh` — the real file is
**gitignored**. It is sourced **last** (after `agents.sh`, `config.sh`, `review-config.sh`),
so it wins over shipped defaults; use `: "${VAR:=value}"` so an explicit CLI flag / env var
still wins over it. Set `RALPH_NO_LOCAL_CONFIG=1` to skip sourcing it (the test suite does).

### Provider credentials

- **Z.AI**: `RALPH_ZAI_AUTH_TOKEN` (no default) and `RALPH_ZAI_BASE_URL`
  (default `https://api.z.ai/api/anthropic`). These stay as *runtime env references* inside
  the composed command precisely so the token is never expanded into the logged command
  (`agents.sh:ralph_provider_cmd`, `zai|zlaude` branch).
- **Anthropic**: the `claude` backend deliberately runs under
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL`
  so a stray key/endpoint cannot silently redirect it.
- **Other providers (incl. DeepSeek): there is no built-in backend and no
  `RALPH_DEEPSEEK_*` variable in this harness.** `deepseek` appears only as (a) a pricing
  key + the `dlaude` alias in `pricing.json`, and (b) the `backstop: true` rung name in
  `efficiency.json.example`. To actually run it you define your own wrapper backend —
  e.g. `AGENT_DLAUDE_CMD='dlaude -p … "$(cat {prompt})"'` in `config.local.sh`, with the
  endpoint and key kept inside the wrapper script, never in the repo. Any
  claude-CLI-to-alternate-endpoint wrapper **must** `unset ANTHROPIC_API_KEY` (a stray key
  outranks `ANTHROPIC_AUTH_TOKEN` and sends the run to real Anthropic — root cause of #22).

**Composition:** roles/backends are the *base* selection. Efficiency mode (§5) can override
`BUILDER`/`REVIEWER` **per ticket**; auto-escalate (§6) can override them again **per rung**.
`RALPH_CRON_DRIVER` (§4) never touches them, and they never touch it.

---

## 3. Manager role / skill

- **What**: the frontier-model verification gate inside the *target* repo — acceptance,
  merge, prod deploy, and the paper trail. Charter template:
  `.agents/ralph/target-templates/manager-SKILL.md`.
- **Enable**: `ralph init-target --repo <target>` copies it to
  `<target>/.claude/skills/manager/SKILL.md` (plus `LABELS.md`), then you boot `/manager`
  in a session inside that repo. Existing files are **never overwritten** without `--force`
  — the Manager edits its own "Project facts" section in place (`bin/ralph:1231-1254`).
- **Default**: not booted. Unmanaged mode (you drive `ralph review`/`ralph batch`) needs no
  Manager at all — see [modes.md](modes.md).
- **Composition**: the Manager is *above* the harness; it does not change any flag here. Two
  couplings matter:
  - it runs on a credential pool that efficiency mode reserves quota for —
    `RALPH_MANAGER_POOL`, defaulting to the `anthropic` pool (§5);
  - it reads, never rewrites, `.ralph/ledger.jsonl` (§11).

---

## 4. Orchestrator loop + `RALPH_CRON_DRIVER`

- **What**: the **driver** is the third role — the agent that wakes on your recurring cadence
  (cron, timer, session loop), reads `.agents/ralph/ORCHESTRATOR.md` and runs one pass. It is
  **not** the builder or the reviewer.
- **Enable** (either spelling; the normalized spec wins if both are set):
  - `RALPH_CRON_DRIVER="<backend name>"` — anything `resolve_backend_cmd` accepts;
  - `RALPH_CRON_DRIVER_PROVIDER` + `_MODEL` + `_EFFORT` — composed by the same adapter the
    roles use, exposed as the synthetic backend `ralph-cron` (`AGENT_RALPH_CRON_CMD`).
- **Default when unset**: `RALPH_CRON_DRIVER_DEFAULT` → `$DEFAULT_AGENT` → `codex`
  (`agents.sh:ralph_resolve_cron_driver`). No vendor is hardcoded — repoint `DEFAULT_AGENT`
  or `RALPH_CRON_DRIVER_DEFAULT` and every unset caller follows.
- **How it is used**: a driver script/cron entry calls `ralph_resolve_cron_driver`, which
  prints the command **and** exports `RALPH_CRON_DRIVER_BACKEND` / `RALPH_CRON_DRIVER_CMD`.
  Because `cmd="$(ralph_resolve_cron_driver)"` runs in a subshell, a caller that wants those
  exports must invoke it directly and redirect stdout instead. The driver is composed in
  **build (writable)** mode — unlike the reviewer it must act.
- **Metering**: the loop meters the builder and the reviewer, **never the driver** — its own
  context (reading `ORCHESTRATOR.md`, dispatching every round) is invisible until you record it
  with `ralph log-usage` (§11.1), which is what makes the per-round cost complete.
- **Composition**: independent of `BUILDER`/`REVIEWER` in both directions. Its one real
  coupling is efficiency mode: the driver's backend is mapped to a pool through the profile's
  own rungs, and that pool carries the `orchestrator_pct` reserve (§5). Point the driver at
  `zai` and the zai pool carries 50 %; point it at `codex` and the openai pool does instead.
- **Floor guard** (mechanical, identity-agnostic): `source .agents/ralph/floor-guard.sh` in
  the orchestrator shell prepends `gh`/`git` shims that refuse PR merge/approve and pushes to
  the default branch. Armed as soon as it is sourced; `RALPH_FLOOR_GUARD=off` disables it with
  a loud warning; `RALPH_DEFAULT_BRANCH` overrides the autodetected protected branch
  (falls back to `main`). PATH-scoped to that shell, so builders/reviewers are unaffected.

### 4.1 Setting up the unattended loop (and the four pitfalls)

`RALPH_CRON_DRIVER` says *which* agent wakes up; it does not schedule anything. The wiring
around it — the wrapper script the scheduler runs, and the scheduler unit itself — is yours.
**Do not hand-write it.** Two templates ship, both `.example` so you copy and fill them in
(nothing machine-specific is committed):

| Template | Copy to | What it is |
|---|---|---|
| `.agents/ralph/target-templates/unattended-loop.sh.example` | `<target>/scripts/unattended-loop.sh` (`chmod +x`) | the wrapper: resolves the driver, feeds it one pass |
| `.agents/ralph/target-templates/unattended-loop.plist.example` | `~/Library/LaunchAgents/com.<you>.ralph-loop.plist` | the launchd unit (macOS) |

Install and smoke-test in this order — run the wrapper **by hand** once before you hand it to
a scheduler, because a scheduler failure looks like nothing happening at all:

```sh
cp .agents/ralph/target-templates/unattended-loop.sh.example <target>/scripts/unattended-loop.sh
chmod +x <target>/scripts/unattended-loop.sh
$EDITOR <target>/scripts/unattended-loop.sh          # fill the CONFIGURE block
<target>/scripts/unattended-loop.sh                  # one pass, in your own terminal
tail -f <target>/.ralph/loop-logs/loop-*.log         # what the scheduler will see
```

The wrapper exists because four traps come up every single time someone writes their own. Each
is a real failure mode with a real fix, and the template already applies all four:

1. **The inline-quoted prompt.** A pass prompt pasted into the wrapper as a quoted string dies
   on the first apostrophe, `$` or backtick in it — usually *silently*, with the driver running
   a truncated instruction (this is the same class of bug as #21, which `tests/shell-syntax.mjs`
   was added for). **Fix:** the prompt lives in a **file** and is passed by *path* or on
   *stdin*, never interpolated as text. The template does exactly what
   `review-loop.sh:run_backend` does: substitute a `printf '%q'`-quoted path for `{prompt}` if
   the backend takes one, else `eval "$cmd" < "$prompt_file"`. Prompt content is then inert.
2. **Silent stderr.** Under launchd there is no terminal and no default log destination: a job
   that fails before its own logging is up (empty `PATH`, missing `node`, a typo) leaves
   *nothing at all*, and the loop just stops happening. **Fix:** the plist sets both
   `StandardOutPath` **and** `StandardErrorPath` (create the directory yourself — launchd will
   not, and a missing directory makes the job fail to spawn), and the wrapper additionally
   `exec`s its own output to `<target>/.ralph/loop-logs/loop-<date>.log` and propagates the
   driver's exit code instead of swallowing it.
3. **Two identity paths.** `bin/ralph` prefers `$PWD/.agents/ralph` over the harness install
   (`bin/ralph:1675`), so *cwd decides* which `config.local.sh` its loops read — while your
   wrapper resolved the driver from a possibly different one. Worse, `config.local.sh` uses
   `: "${VAR:=value}"`, which **sets but does not export**: the values are visible to the
   wrapper and invisible to the `ralph` child process, so `ralph integrate --pr` cannot resolve
   the identity wrapper (§12) and the PR is filed by whatever ambient `gh` account exists —
   loudly (the degraded notice lands in the PR body and the log), but still as the Owner.
   **Fix:** the wrapper `cd`s into the target *first*, sources **both** `config.local.sh` files
   (harness, then target — target wins) inside `set -a` so everything is exported, then sources
   `resolve-identity.sh` and exports `RALPH_IDENTITY_WRAPPER` once. Driver launch and ralph's
   own identity path then agree by construction.
4. **Plan artifacts in the repo root.** A PRD/story JSON written next to `package.json` makes
   the tree dirty, and `ralph review`/`ralph batch` refuse a dirty target (`--allow-dirty`
   aside) while `integrate` refuses to merge one. **Fix:** everything the loop generates is
   staged under `<target>/.ralph/` — already gitignored by `ralph init-target`
   (`bin/ralph:1156`) and explicitly filtered out of ralph's own dirty-check. The wrapper
   creates `.ralph/plans/` and exports `RALPH_LOOP_PLAN_DIR`, and its pass prompt tells the
   driver to write plans there and pass them in with `ralph review --prd "$RALPH_LOOP_PLAN_DIR/…"`.
   (`RALPH_LOOP_PLAN_DIR` is the template's contract with its own prompt file; `bin/ralph` does
   not read it.) It also pins `RALPH_WORKTREE_DIR` under `.ralph/` so run worktrees cannot land
   in the tree either.

**Not on macOS?** The plist is the only macOS-specific piece; the wrapper is portable and takes
all its input from the environment. Use whichever scheduler you have, and keep pitfall 2 in
mind — both must capture *both* streams:

```sh
# cron — hourly. Redirect explicitly; cron mails output by default, which on most boxes
# means it is dropped. Cron gives you a near-empty PATH, so the wrapper sets its own.
0 * * * * TARGET_REPO=/path/to/target RALPH_HOME=/path/to/ralph-harness \
  /path/to/target/scripts/unattended-loop.sh >> /var/log/ralph-loop.log 2>&1
```

```ini
# systemd --user: ralph-loop.service + ralph-loop.timer in ~/.config/systemd/user/.
# journald captures both streams (journalctl --user -u ralph-loop), so this pitfall is
# handled for you; Environment= replaces the plist's EnvironmentVariables dict.
[Service]
Type=oneshot
Environment=TARGET_REPO=/path/to/target
Environment=RALPH_HOME=/path/to/ralph-harness
ExecStart=/path/to/target/scripts/unattended-loop.sh

[Timer]
OnCalendar=hourly
Persistent=true
```

The wrapper takes a `mkdir`-based lock in `.ralph/loop.lock`, so a cadence shorter than one
pass skips rather than stacking two drivers on the same worktree — on any scheduler.

### 4.2 Picking the driver by LIVE usage — `ralph pick-driver`

**Opt-in and read-only.** Nothing calls it: an operator or a cron wrapper does, and then does
what it likes with the answer. This is the **supported way to pick a driver by live usage** —
the alternative operators reach for otherwise is a clock rule (`if hour < 12 then codex`), a
static proxy for "which pool is cheaper now" that keeps picking a pool at 95 % while another
sits at 10 %.

```bash
# The whole point, in a cron wrapper:
export RALPH_CRON_DRIVER="$(ralph pick-driver --repo "$TARGET_REPO" \
  --candidates codex,zlaude --default codex)"
```

- **What it prints**: on stdout, **only** the driver name — so `$(...)` capture is the intended
  use. The reasoning (every candidate's numbers, the notes, the verdict) goes to **stderr**, so
  it is visible in a log and never contaminates the value. `--json` prints the full record,
  `--shell` prints eval-able `RALPH_PICK_DRIVER_*` assignments (`_STATUS`, `_DRIVER`, `_POOL`,
  `_HEADROOM_PCT`, `_DEFAULT`, `_REASON`, …).
- **Candidates**, in precedence order: `--candidates a,b` / repeated `--candidate <name>`
  (best-liked first), then `RALPH_CRON_DRIVER_CANDIDATES` (comma/space separated), then **every
  backend the efficiency profile's rungs declare**, cheapest rung first. A candidate is a
  backend name whose pool is looked up in the profile's rungs, or `name=pool` when the profile
  does not map it.
- **How it ranks them** — the distance to the first gate that would stop the driver:

  ```text
  headroom = min( 5h ceiling - 5h used , weekly ceiling - weekly used )
  ```

  The **5 h ceiling** is the pool's `window_5h_pct` cap (100 % if it declares none) and is never
  relaxed — it is a rate limit. The **weekly ceiling** is its `window_weekly_pct` cap, further
  reduced by the weekly **reserve other control-plane roles** hold on that pool (§5): the
  manager's, typically. The **orchestrator's own reserve is deliberately not charged** — the
  driver *is* the orchestrator, so that share is quota set aside for this very run. Near the
  weekly reset (`reserves.near_weekly_reset_hours`) the weekly cap **and** the reserve are
  lifted, exactly as `efficiency.py select` lifts them. Most headroom wins; a tie keeps the
  order you gave.
- **Where the numbers come from**: the same readers as everything else —
  `efficiency.read_ledger_usage` → `usage-state.py`, i.e. ledger tokens vs the pool's
  `window_*_budget_tokens`, a ledger `quota` block, or the pool's own `usage_provider` adapter
  (§5/#68) for a %-only plan. Nothing is re-implemented here and **no percentage is invented**.
- **Held back rather than ranked**: a candidate whose pool has an **open quota circuit** (pass
  the pools with `--exhausted-pool <pool>`, repeatable — `ralph_efficiency_open_circuit_pools`
  in `efficiency.sh` prints exactly that list) or an **active avoid window**.
- **FAIL-OPEN, always exit 0**: a candidate with no usable percentage for either window is
  reported *unavailable* and left out of the ranking. When **no** candidate can be ranked — no
  usage data anywhere, a missing or rejected profile, a broken/slow adapter, no candidates at
  all — it prints the **documented default** and says it is a fallback: `--default <name>`
  (your own rule, e.g. the calendar rule you are replacing), else whatever `RALPH_CRON_DRIVER`
  resolves to right now (`ralph_resolve_cron_driver`, including its documented default chain).
  The only non-zero exit is **2, for bad CLI usage** (an unknown option) — never a runtime miss.
- **Read-only**: it opens the ledger and the profile, runs each pool's own usage adapter (what
  that adapter is for), and writes nothing — no ledger mutation, no dispatch, no agent started.
  `--efficiency` does not have to be on: the profile is read as *data* here.

```bash
ralph pick-driver --repo <target> --candidates codex,zlaude --json   # the full record
ralph pick-driver --repo <target> --candidate zlaude=zai --default codex --shell
```

Its own gitignored profile applies: with no `efficiency.json` there are no pools, caps or
reserves to read, so every candidate is unavailable and you always get the default — configure
the profile (§5) first if you want this to do anything.

---

## 5. Efficiency mode — `--efficiency` + `efficiency.json`

**Opt-in, DEFAULT OFF.** Without the flag none of this code runs and dispatch is byte-for-byte
the `--builder`/`--reviewer` path (pinned by `tests/efficiency-select.mjs`).

- **Enable**: `--efficiency`, or `RALPH_EFFICIENCY` set to `1|true|yes|on` (case-insensitive,
  `efficiency.sh:ralph_efficiency_enabled`). Valid on `ralph review` and `ralph batch`.
- **Profile**: `<repo>/.agents/ralph/efficiency.json`, overridable with
  `--efficiency-profile <path>` / `RALPH_EFFICIENCY_PROFILE`. The real file is **gitignored**
  (operator policy, like `config.local.sh`); only `efficiency.json.example` ships:
  `cp .agents/ralph/efficiency.json.example .agents/ralph/efficiency.json`.
  On `ralph explain`, a plain `--profile` also means this path (everywhere else `--profile`
  is the `cheap|balanced|max` agent preset).

### What the profile declares

| Block | Meaning |
|---|---|
| `rungs` | The ladder, **cheapest first**. Each rung names a `backend` + credential `pool` per role. |
| `caps` | Keyed by pool. `{window_5h_pct, window_weekly_pct}` = stop at that share of the window; `{source: "provider"}` = the provider meters it, no local cap; `{source: "provider_pct", usage_provider: "<script>"}` = the pool's own adapter reports the percentages (see below); `{backstop: true}` = uncapped last resort. |
| `caps` (optional, #60) | `window_5h_budget_tokens` / `window_weekly_budget_tokens` — with no `usage_provider`, the **only** thing that turns ledger token sums into a percentage; `weekly_reset_anchor` — an ISO-8601 UTC instant the week repeats from. |
| `caps` (optional, #68) | `usage_provider` — path to a script (relative to the target repo) printing `{"window_5h_pct", "window_weekly_pct", "weekly_reset_at"}`. Valid on any cap shape and **required** by `source: "provider_pct"`. For a pool whose provider publishes usage as a **percentage only** and sells no token budget (an Anthropic Pro/Max plan — the pool the manager runs on): its percentages are used exactly like budget-derived ones, so the cap and the reserves the pool carries bind with no budget. Add `window_5h_pct` / `window_weekly_pct` to the same block to give it a local cap; without them it applies no cap but still feeds the reserves. A script that exits non-zero, times out (20 s, `RALPH_USAGE_PROVIDER_TIMEOUT` to move the bound; the script and anything it spawned are killed) or prints unparseable output **fails open** (`pct` unknown, the quota circuit of §9 stays the gate) — it never crashes the harness. Contract + a working implementation: `.agents/ralph/usage_provider.example.sh` (copy to `.agents/ralph/usage_provider.sh`, gitignored). |
| `avoid_windows` | Per rung: `from`/`to` as `HH:MM` in `tz` (UTC only), `days` like `Mon-Fri` / `Sat,Sun` / `*`. Inside the window the rung is ineligible. |
| `reserves` | Keyed by **role**: `manager_pct`, `orchestrator_pct`, `near_weekly_reset_hours`. |
| `tiers` | Which rungs each complexity (`trivial\|small\|medium\|large`) may use, in preference order. |

### Selection rules (enforced in code, not by the profile)

`ralph_efficiency_select <tier> [repo]` (`efficiency.sh`) / `efficiency.py select` walks the
tier's rungs and takes the **first eligible** one. A pool is ineligible when an avoid window is
active, its quota circuit (§9) is open, or it breaches its cap / weekly reserve.
At boot, each rung's builder and reviewer are checked through the canonical
`resolve_backend_cmd`: unresolvable names produce a warning and make that rung ineligible for
dispatch, allowing selection to fall through. `ralph explain` reports the same rung as
`UNRESOLVABLE` and names the backend. The standalone Python policy seam remains independent of
installed agent configuration unless its caller supplies resolvability results.

- **Reserves follow the control-plane ROLE, not the pool.** `manager_pct` (**25**) applies to
  `RALPH_MANAGER_POOL` or, unset, the `anthropic` pool; `orchestrator_pct` (**50**) applies to
  whichever pool `RALPH_CRON_DRIVER` resolves onto. When both roles share a pool the reserves
  **stack** (25 + 50 = 75). A pool no control-plane role runs on carries no reserve.
- **The defaults apply even if the profile omits them.** Omitting `manager_pct` /
  `orchestrator_pct` does **not** switch the reserve off — the built-in 25 / 50 (and
  `near_weekly_reset_hours` = 5) apply. The profile supplies numbers, not the switch.
- **Near the weekly reset**, both weekly gates (cap *and* reserve) are relaxed. The rolling
  5 h cap is never relaxed.
- **Unknown usage fails open** — no budget and no quota observation means no percentage, and a
  missing number must not freeze the ladder; the hard quota circuit stays the real gate.
- **Backstop**: if no rung of the tier is eligible, the `backstop: true` rung is used even when
  the tier does not list it (exempt from caps and reserves; only its own circuit or avoid
  window can take it out).
- **Return codes**: `0` = selected, `3` = bounded PAUSE, `4` = inert.

### Dispatch (#62) — per ticket, only under the opt-in

The ticket's complexity comes from a `complexity:<tier>` label, or the PRD story's
`complexity` field / `complexity:` label. The chosen rung overrides `--builder`/`--reviewer`
**for that ticket only**, and is recorded in `efficiency-dispatch.jsonl`, `final_status.md` /
`final-report.md`, the per-task result used for the PR body, `last-run.env`, and the
`efficiency` block of that round's ledger record.

Three ways it steps aside instead of surprising you:

| Situation | Behaviour |
|---|---|
| Ticket has no `complexity:<tier>` | Inert + loud warning; your normal `--builder`/`--reviewer` runs. |
| Profile missing or invalid | **Reject-to-safe**: loud stderr warning, mode falls back to inert/off. Never fatal, never partially enforced. |
| No eligible rung, not even the backstop | Clean **bounded pause**: `EFFICIENCY_PAUSED`, **exit 5**, artifacts kept, reason + retry instant published. In a batch, completed tasks stay committed and `--resume` picks up; in a review nothing was created yet. |

### Reading the policy back (read-only, dispatches nothing)

```bash
ralph explain --complexity medium [--repo <target>] [--profile <path>] [--json]
.agents/ralph/usage-state.sh --repo <target> [--profile <path>] [--json]
```

`usage-state.sh`/`usage-state.py` is the **read-only** per-pool reader: 5 h + weekly token sums
from `.ralph/ledger.jsonl`, turned into a pct only when the profile sets that pool's
`window_*_budget_tokens` (otherwise `pct=unknown` and raw tokens are shown — a percentage is
never invented), plus reset proximity and avoid-window-now. It is a **local estimate**: no
provider usage API is called, and it writes nothing.

---

## 6. Auto-escalate — `--auto-escalate`

**Opt-in, DEFAULT OFF, `ralph review` only.** (`bin/ralph` wires `RALPH_AUTO_ESCALATE` /
`RALPH_ESCALATE_ITERATIONS` in the review branch only — `ralph batch` ignores the flag.)

- **Enable**: `--auto-escalate`, or `RALPH_AUTO_ESCALATE=1|true|yes|on`.
- **Per-rung budget**: `--escalate-iterations <n>` / `RALPH_ESCALATE_ITERATIONS`, **default 3**
  (`review-loop.sh:423`). This replaces `--max-iterations` as the per-attempt budget *within*
  a rung.
- **What it changes**: a rung that spends its budget without a `VERDICT: PASS` is **promoted**
  to the next stronger **eligible** rung and retried with a fresh budget, carrying the
  reviewer's must-fix feedback forward.
- **Bounded by construction**: `ralph_efficiency_escalate_select` → `efficiency.py select
  --after-rung` only ever looks **above** the failed rung, so the ladder strictly shrinks.
  Eligibility is *not* relaxed to make a promotion possible — the same avoid windows, caps,
  quota circuits and role reserves apply, so an ineligible rung is skipped, not used.
- **Outcomes**: a PASS at any rung ends the run normally (`READY_FOR_HUMAN_REVIEW`);
  exhausting the ladder ends it on `FAILED_ESCALATION_EXHAUSTED` (**exit 2**) naming every rung
  tried, e.g. `cheap -> mid -> strong -> backstop (all failed)`.
- **Recorded in**: `<run>/escalations.jsonl`, `.ralph/ledger.jsonl` as an `event` record
  (`ralph report` skips it — it carries no token totals), the run banner, `final_status.md`,
  and `last-run.env`.
- **Composition**: it needs the `--efficiency` rung ladder. With the flag but efficiency
  off/inert, or a story with no `complexity:<tier>`, it is a **no-op with a note**. Without the
  flag, a spent budget is still `FAILED_MAX_ITERATIONS`, byte-for-byte
  (`tests/auto-escalate.mjs` pins both).

### 6.1 Launch-failure escalation — `ralph batch`, part of `--efficiency`

**No flag of its own: it is active exactly when `--efficiency` gave the task a rung** (and
`ralph batch` only). Distinct trigger from §6: that one reacts to a *verdict*, this one to a
backend that **never ran**.

- **What it reacts to**: the builder or reviewer backend fails to LAUNCH — a non-zero /
  backend-unavailable ERROR on all `RALPH_AGENT_RETRIES`+1 invocations (logged out,
  rate-limited, wrong binary path, auth error), *or* a rung naming a backend that is not
  installed on this machine. None of that is a `VERDICT: FAIL`, so `--auto-escalate` never
  sees it.
- **What it changes**: instead of halting the whole batch on one dead CLI, the **task** is
  promoted to the next stronger **eligible** rung and the failed role is re-launched there
  (the builder is not re-run when it was the reviewer that died). The rung owns both roles,
  so a promotion rebinds both.
- **Bounded by construction**: the same `efficiency.py select --after-rung` rung-advance
  helper as §6 (`ralph_efficiency_launch_escalate_select` → `ralph_efficiency_advance_rung`),
  so each hop only looks *above* the current rung, the ladder strictly shrinks, and the
  backstop is the last rung that can be tried. A rung that cannot even be bound is climbed
  past, not died on.
- **Outcomes**: a launchable rung finishes the task normally; exhausting the ladder halts the
  batch on `LAUNCH_ESCALATION_EXHAUSTED` (**exit 4**, resumable) naming every rung tried,
  e.g. `cheap -> mid -> strong -> backstop`.
- **Recorded in**: `<run>/escalations.jsonl` and `.ralph/ledger.jsonl` as an `event` record
  with `trigger: builder_launch_failure|reviewer_launch_failure` (§6's promotions carry
  `trigger: iteration_budget`), the per-task `task-NNN-result.md` PR body, `final-report.md`,
  the run banner and `last-run.env` (`LAUNCH_ESCALATIONS`, `LAUNCH_ESCALATION_RUNGS`,
  `LAUNCH_ESCALATION_ROLE`, `LAUNCH_ESCALATION_REASON`).
- **Composition**: a **provider quota wall** keeps its own reactive path (§9) — a stronger
  rung sits behind the same wall, so a quota ERROR still ends the batch as
  `PROVIDER_QUOTA_EXHAUSTED` rather than escalating. Without a rung ladder (no
  `--efficiency`, an inert profile, or a task with no `complexity:<tier>`) the halt is
  byte-for-byte today's `BUILDER_UNAVAILABLE`/`REVIEWER_UNAVAILABLE`
  (`tests/launch-escalate.mjs` pins both halves).

---

## 7. `--max-iterations`

- **What**: builder/reviewer cycles — per story in `ralph review`, per task in `ralph batch`.
- **Enable / set**: `--max-iterations <n>`, env `MAX_ITERATIONS`, or `MAX_ITERATIONS` in
  `config.local.sh` / `review-config.sh`.
- **Default**: **5** (`review-loop.sh:107`, `batch-loop.sh:157`). (`.agents/ralph/loop.sh`, the
  older single-agent build loop, has its own `MAX_ITERATIONS` — the `config.sh` comment shows
  `25`.)
- **Composition**: exhausting it is `FAILED_MAX_ITERATIONS`. Under `--auto-escalate` the
  effective per-attempt budget becomes `--escalate-iterations` *per rung* instead (§6). It is
  unrelated to `--max-tasks` (how many tasks a batch runs) and to `RALPH_AGENT_RETRIES`
  (retries for a tooling **ERROR**, which consume no builder attempt).

---

## 8. `RALPH_USAGE` — per-attempt token/cost capture

- **What**: makes instrumented backends emit machine-readable usage, captured into a sidecar
  next to each attempt log:
  `.agent-run/<run>/task-<NNN>-iter-<N>-<role>.usage.json` with numeric
  `input`/`output`/`cache_read`/`cache_creation` tokens (plus `num_turns`, `duration_ms`,
  `total_cost_usd` where reported).
- **Default: ON — this one is opt-OUT.** `RALPH_USAGE=0` disables it
  (`batch-loop.sh:253` tests `${RALPH_USAGE:-1}`). Cost visibility on capped plans is the point
  of the harness, and the extraction is safe: the JSON is always converted back to plain text
  before the verdict grep, and an unrecognised shape is **salvaged** (verdict still parses) with
  a warning that metrics were skipped.
- **Scope**: `ralph batch`. Instrumented families:
  claude-CLI → `--output-format json`; codex → `--json` on `exec`. **opencode is deliberately
  not instrumented** (its usage field names are unverified). Extend wrapper coverage with
  `RALPH_CLAUDE_LIKE` (default `claude rlaude zlaude`) / `RALPH_CODEX_LIKE` (default `codex`).
- **Composition**: usage feeds the per-round totals → `round-usage.jsonl` → `.ralph/ledger.jsonl`
  → `ralph report` (§11), and the observable total that `RALPH_ORCHESTRATOR_BUDGET_TOKENS`
  (§10) measures against. Turning it off blinds all three.

---

## 9. `RALPH_QUOTA_REGEX` — terminal provider window, and credential pools

- **What**: detects a genuinely exhausted provider usage window in a captured backend log and
  opens a **circuit** for that credential pool. Deliberately narrower than a generic HTTP 429:
  the default requires both an explicit usage-limit exhaustion **and** a reset time, so a
  transient 429 does not trip it.
- **Default ERE** (`agents.sh:ralph_detect_quota_exhaustion`):

  ```
  usage[[:space:]]+limit[[:space:]]+reached.*reset[[:space:]]+at[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}
  ```

- **Enable / override**: set `RALPH_QUOTA_REGEX` to your provider's terminal wording.
- **Credential pools**: pool identity defaults to the provider name; set
  `RALPH_BUILDER_CREDENTIAL_POOL` / `RALPH_REVIEWER_CREDENTIAL_POOL` when two backend names
  share one plan's quota. On a match the harness exports `RALPH_QUOTA_PROVIDER`,
  `RALPH_QUOTA_CREDENTIAL_POOL`, `RALPH_QUOTA_SCOPE`, `RALPH_QUOTA_OBSERVED_AT`,
  `RALPH_QUOTA_RESET_AT` and appends `pool|reset` to `RALPH_QUOTA_OPEN_CIRCUITS`; with
  `RALPH_QUOTA_ARTIFACT` set it also persists a `STATUS=PROVIDER_QUOTA_EXHAUSTED` env file.
- **Effect**: an open pool is skipped for the rest of the run; unrelated pools stay
  dispatchable; a parsed reset time that has elapsed closes the circuit automatically. In a
  batch the run halts as `PROVIDER_QUOTA_EXHAUSTED` recording provider + reset time.
- **Composition**: efficiency mode **reuses this exact circuit** (`ralph_quota_pool_is_exhausted`)
  as one of its eligibility gates — it never re-implements quota detection. It is also the
  "real gate" the fail-open rule in §5 defers to. Distinct from an *agent ERROR*
  (`RALPH_AGENT_RETRIES`, default 2, exponential backoff, then
  `BUILDER_UNAVAILABLE`/`REVIEWER_UNAVAILABLE`, exit 4) — which under `--efficiency` escalates
  up the rung ladder first (§6.1), while a quota wall never does.

---

## 10. `RALPH_ORCHESTRATOR_BUDGET_*` — proactive token ceiling

- **What**: stops a batch cleanly once cumulative observable builder+reviewer usage reaches a
  ceiling you set.
- **Enable**: `RALPH_ORCHESTRATOR_BUDGET_TOKENS=<n>`. **Unset = feature off** (there is no
  flag; it is env-only).
- **`RALPH_ORCHESTRATOR_STOP_PCT`**: percentage applied to the ceiling, **default `100`**.
  Both values must be finite and > 0 or the run errors out.
- **Scope**: `ralph batch` only (`batch-loop.sh:1094-1157`, `orchestrator-budget.sh`).
- **Behaviour**: the completed round's usage is flushed first, then the batch ends as
  `ORCHESTRATOR_BUDGET_REACHED`, with budget, pct, threshold, observed total and
  unknown-round count in `last-run.env` and the banner. **Unknown round totals count as zero**
  and are reported separately rather than guessed at.
- **Composition**: it measures the same numbers `RALPH_USAGE` captures — with `RALPH_USAGE=0`
  every round is "unknown", contributes zero, and the ceiling is never reached. It is a
  *per-run* ceiling and is independent of efficiency-mode caps/reserves, which are *per-pool,
  per-window* policy.

---

## 11. Pricing, the ledger, and `ralph report`

### `.ralph/ledger.jsonl` — the cross-run, append-only log

- Written in the **target** repo. Three writers:
  - `round-usage.sh` — one record per completed **batch** round (timestamp, round id, per-role
    provider/model, attempt counts, `tokens.{input,output,cached,total}`, `run_id`, `target`;
    plus an `efficiency` block **only** when efficiency mode actually decided something, so a
    default run writes exactly the record it always has);
  - `efficiency.sh:ralph_efficiency_escalation_record` — an `event` record per auto-escalate
    promotion (from/to rung, reason, iteration; no token totals);
  - `ralph log-usage` — one **single-role** record per driver/orchestrator pass you feed it
    (`role`, `pool`, `model`, `provider`, `timestamp`, the same `tokens` block, `source:
    "log-usage"`). Nothing writes these automatically; see §11.1.
- **Two line shapes, and the difference is not cosmetic.** A round record covers builder *and*
  reviewer with **one** token total (their sidecars are summed), so there is no honest per-role
  split and `ralph report` reports it under the combined role `builder+reviewer`. A single-role
  record's tokens are that role's alone.
- **Agents may read it; they must never truncate, rewrite, or edit it** (stated in both the
  Manager and Orchestrator charters).
- It is also the input to the per-pool usage reader that efficiency mode selects from (§5).

### `ralph report`

```bash
ralph report [--repo <target>] [--json]
```

Per-ticket usage/cost summary. `--repo` defaults to `TARGET_REPO`, else the current directory.
Cost is **captured tokens × the producing backend's provider rate**, *not* the CLI's
`total_cost_usd`. `event` records (escalations) are skipped. Unknown providers yield
`cost_usd = "unknown"` rather than a guess. **Read-only**: it never writes to the ledger.

Grand totals are additionally broken out **by role** and **by pool** (`by_role` / `by_pool` in
`--json`), which is what makes the driver's share visible next to the dispatched agents':

- `by_role` rows are `builder+reviewer` (every round record) and whatever single roles the
  ledger holds (`driver`, `orchestrator`). Each row is itself split per pool.
- `by_pool` rows carry the roles that drew on that pool.
- A line's pool is the one it declares: `pool` on a single-role record, `efficiency.builder_pool`
  on a round. A round dispatched without efficiency mode declares none and lands in the pool
  named `unknown` — no pool is inferred from the provider. When a round's reviewer drew on a
  different pool than its builder, the round is attributed to the **builder's** pool (one token
  total, no split) and a note says how many rounds that was.

### 11.1 `ralph log-usage` — recording the driver's own usage

```bash
ralph log-usage --role driver --pool anthropic --usage-json driver.json \
  [--provider claude] [--model <id>] [--round task-007] [--run-id <id>] [--repo <target>] [--json]
```

The builder and reviewer are metered automatically; the **driver** (§4) is not — it runs outside
the loop, and on a capped plan it is usually the largest single consumer. This hook closes that
gap: it reads the usage JSON the driver's own CLI already prints and appends **one**
`role=driver|orchestrator` line to `.ralph/ledger.jsonl`. Capturing that JSON inside the
unattended wrapper is the wrapper's job (§4.1); this command is what it — or you, interactively
— calls.

- **`--usage-json`** accepts a file or `-` (stdin), in any of the three shapes the tools already
  emit: a claude-family `--output-format json` result object, a `codex --json` JSONL stream (the
  usage rides the **final** `turn.completed`), or a harness `*.usage.json` sidecar. Field names
  match `extract_usage` exactly, so the hook and the automatic capture read the same log the
  same way.
- **`--role`** takes `driver` or `orchestrator` only. `builder`/`reviewer` are **rejected** —
  those rounds are already metered, and logging them again would double-count.
- **`--provider`** prices the line; it defaults to the **pool name**, which is correct whenever
  the pool is named after its provider (`anthropic`, `openai`, `zai`, …). A pool named anything
  else needs it explicitly, or the cost is `unknown`.
- **`--round`** folds the pass into that ticket's total, so per-round cost finally includes the
  driver. Without it the line lands under the standing pseudo-ticket `driver`.
- **`--model`** defaults to what the JSON reports (the claude family's `modelUsage`), else
  `unknown`. Nothing is guessed.
- **Failure mode**: a missing flag, a `builder`/`reviewer` role, or a usage JSON with no usable
  token counts is an error (**exit 2**) that writes **nothing** — an under-counted driver is
  worse than a loud refusal. Writing is append-only; existing lines are never read back or
  rewritten.
- **Not wired into pool selection**: efficiency mode's per-pool windows (§5) still read
  builder-attributed rounds only, so a driver line changes what you can *see*, not what the
  harness dispatches.

### `RALPH_PRICING_FILE`

- **Default**: `.agents/ralph/pricing.json`, shipped next to `report.py`.
- **Override**: point `RALPH_PRICING_FILE` at your own file with the same schema —
  `{"providers": {"<name>": {"input", "output", "cache_read", "cache_write"}}, "aliases": {...}}`,
  all rates **USD per million tokens**; `cost_usd = tokens × rate / 1_000_000`.
- **Failure mode**: an unreadable/invalid override silently falls back to the shipped
  `pricing.json`, and then to an empty table (everything `unknown`) — it never crashes a report
  (`report.py:_load_pricing`).

---

## 12. Identity marker

- **What**: which `gh`/`git` identity wrapper the Manager/Orchestrator act under, so the
  orchestrator identity can never approve, merge, push main, or deploy prod.
- **Resolution order** (`.agents/ralph/resolve-identity.sh`):
  1. `ralph.target.json` `identity` block with `enabled: true` (+ `wrapper`, `role`) —
     **authoritative; resolution stops here**;
  2. `RALPH_IDENTITY_WRAPPER` (when it names an executable file);
  3. `<target>/.agents/ralph/identity.sh` (when executable);
  4. ambient `gh auth`.
- **Default**: no marker → step 4, and that fallback is **correct, not degraded** (it is still
  disclosed on every write — see below).
- **The marker changes the failure mode, which is the point**: with `identity.enabled=true` but
  no resolvable wrapper, the status is **`DEGRADED`** (loud warnings in PR bodies and to the
  Manager) rather than a quiet fallback. Without the marker, an unresolvable wrapper is just
  `FALLBACK`.
- Outputs (printed when run directly, exported when sourced): `RESOLVED_WRAPPER`,
  `IDENTITY_STATUS` (`resolved|degraded|fallback`), `IDENTITY_SOURCE`,
  `IDENTITY_MARKER_ENABLED`, `IDENTITY_MARKER_ROLE`.
- **Who files the PR (#71)**: `ralph integrate --pr` resolves the identity with that script
  (same order, never re-implemented) and, when it resolves, runs **both** GitHub writes under
  the wrapper — `"$RESOLVED_WRAPPER" <role> git push …` and `… gh pr create …`, with `<role>`
  from `identity.role` (default `orchestrator`) — so the PR is authored by the App. The
  existing-PR lookup uses the same credentials. **Nothing resolved ⇒ ambient `gh`, but never
  silently**: a `DEGRADED MODE` notice naming the status/source goes to **stderr and into the
  PR body**, for `fallback` as well as `degraded`. Fixtures: `tests/integrate-identity.mjs`.
- **Composition**: a *soft* dependency — absent or failing, the Manager works in fallback mode.
  Complementary to, and independent of, the **floor guard** (§4), which enforces the same floor
  mechanically under plain `gh auth`.

---

## 13. How they compose

### 13.1 The precedence chain

For roles and workflow knobs (`config.local.sh.example`, `batch-loop.sh:116`):

```
CLI flag  >  environment variable  >  config.local.sh  >  ralph.target.json "agents"
          >  config.sh / review-config.sh  >  agents.sh defaults
```

Two caveats that bite:

- `config.local.sh` only stays *below* flags/env if you write `: "${VAR:=value}"`. A plain
  `VAR=value` there beats the flag.
- The `ralph.target.json` **`agents`** block is honored by **`ralph batch` only**; `ralph review`
  takes roles from env/CLI and `config.local.sh` (`review-loop.sh:101`).

### 13.2 Dispatch: who actually picks the builder and reviewer

Each layer only runs if the one before it opted in:

```
--builder / --reviewer  (or BUILDER/REVIEWER, config.local.sh, target "agents")
   └─ --efficiency + a ticket with complexity:<tier>  →  rung overrides both, for that ticket
        └─ --auto-escalate + a spent per-rung budget  →  promotes to the next eligible rung
```

Remove the opt-in at any level and every level below it disappears with it: no `--efficiency`
means `--auto-escalate` is a no-op with a note; no `complexity:<tier>` means the rung ladder is
empty, so there is nothing to select from *or* climb.

### 13.3 Which knob gates which

| Layer | Question it answers | Knob |
|---|---|---|
| Preflight | Is the repo baseline healthy at all? | `ralph.target.json` `preflight`, `--no-preflight` |
| Role selection | Who runs this? | `--builder`/`--reviewer`, providers/models/efforts, `--profile` |
| Efficiency policy | *May* this pool run right now? | caps, avoid windows, reserves, quota circuit |
| Iteration budget | How many tries before giving up? | `--max-iterations`, then `--escalate-iterations` per rung |
| Run ceiling | How many tokens may this whole batch spend? | `RALPH_ORCHESTRATOR_BUDGET_TOKENS` / `_STOP_PCT` |
| Hard stop | Has the provider actually cut us off? | `RALPH_QUOTA_REGEX` circuit |

They are checked in that order, and the **hard quota circuit always wins** — efficiency mode
reuses it rather than modelling exhaustion itself, and fails *open* wherever its own numbers are
unknown, so a missing estimate can never freeze the ladder.

### 13.4 Where the control-plane roles couple to cost policy

`RALPH_CRON_DRIVER` and `RALPH_MANAGER_POOL` look like unrelated role settings, but they are
what makes reserves land on the right pool: change the driver and the 50 % orchestrator reserve
**moves with it**, while the pool it left reverts to its plain caps. Share a pool between both
control-plane roles and their reserves stack to 75 %.

That is also why `ralph pick-driver` (§4.2) charges a candidate only the reserves of the *other*
control-plane roles: the driver is the orchestrator, so its own 50 % is the quota it is about to
spend, not quota it must leave alone.

### 13.5 Terminal statuses and exit codes

Both loops end **0** only on `READY_FOR_HUMAN_REVIEW` and **2** on anything else, except
where a distinct code is listed below.

| Status | `review` | `batch` | Cause |
|---|---|---|---|
| `READY_FOR_HUMAN_REVIEW` | 0 | 0 | reviewer PASS + checks green (the loop never merges) |
| `FAILED_MAX_ITERATIONS` | 2 | — | iteration budget spent (auto-escalate off) |
| `FAILED_ESCALATION_EXHAUSTED` | 2 | — | ladder exhausted under `--auto-escalate` |
| `PREFLIGHT_FAILED` | 3 | 3 | repo contract broke before any worktree/agent |
| `BUILDER_UNAVAILABLE` / `REVIEWER_UNAVAILABLE` | 2 | **4** | agent ERROR survived `RALPH_AGENT_RETRIES`; `--resume` continues |
| `LAUNCH_ESCALATION_EXHAUSTED` | — | **4** | `--efficiency`: every rung up to the backstop failed to LAUNCH (§6.1); `--resume` continues |
| `PROVIDER_QUOTA_EXHAUSTED` | 2 | **4** | terminal provider window matched by `RALPH_QUOTA_REGEX` |
| `EFFICIENCY_PAUSED` | **5** | **5** | no eligible rung, not even the backstop; artifacts kept |
| `ORCHESTRATOR_BUDGET_REACHED` | — | 2 | token ceiling hit; usage flushed first |
| `STOPPED_ON_FAIL` | — | 2 | `--stop-on-fail` and a task failed |
| `COMPLETED_WITH_FAILURES` / `COMPLETED_WITH_BLOCKERS` | — | 2 | batch finished with failed / `VERDICT: BLOCKED` tasks |

`NO_CHANGES` is a **per-task** result, not a run status: every builder attempt for that task
produced an empty diff, which is a failure, never a pass.

`ralph status --watch` polls to a terminal status: exit **0** if `READY_FOR_HUMAN_REVIEW`, **2**
otherwise, **124** on timeout (`RALPH_WATCH_INTERVAL_MS` default 15000,
`RALPH_WATCH_TIMEOUT_MS` default 6 h).

---

## 14. The rest of the flag surface

The modes above are the ones with an on/off contract. These are the remaining flags
`bin/ralph` parses — plumbing and selection, no default-OFF semantics of their own. Together
with §1 this is the complete flag surface; `ralph help` is the authoritative list.

| Flag | Commands | Meaning / default |
|---|---|---|
| `--repo <path>` | `review`, `batch`, `preflight`, `status`, `integrate`, `cleanup`, `init-target`, `report`, `explain`, `pick-driver` | Target repo. Falls back to `TARGET_REPO`; **required** for `review`/`batch`, defaults to cwd for `report`/`explain`/`pick-driver`. |
| `--prd <path>` | `build`, `prd`, `review` | Override the PRD JSON. Unset → prompts among `.agents/tasks/*.json`. |
| `--out <path>` | `prd` | PRD output path. Default `.agents/tasks/`. |
| `--progress <path>` | `build` | Override the progress log. Default `.ralph/progress.md`. |
| `--agent <codex\|claude\|droid\|opencode>` | `build`, `prd` | Agent runner for the single-agent loop (not the review/batch roles). |
| `--no-commit` | `build` | Dry run: the loop does not commit (parsed by `loop.sh`, not `bin/ralph`). |
| `--skills` | `install` | Also install the `commit` / `dev-browser` / `prd` skills. |
| `--force` | `install`, `init-target`, `integrate`, `cleanup` | Overwrite on install; integrate a non-ready run; force-remove a dirty worktree. |
| `--task <id>` | `review` | Select a PRD story by id (a bare positional number selects by 1-based index). |
| `--branch <name>` | `review`, `batch` | Override the working branch name (default is generated from the run id). |
| `--plan <dir\|file>` | `batch` | **Required**: a dir of `*.md` (sorted) or one `.md` split by its top heading level. |
| `--max-tasks <n>` | `batch` | Cap how many tasks run. Default: all. |
| `--allow-concurrent` | `batch` | Bypass `<target>/.ralph/batch.lock`. Default: off; use only when every concurrent run has a separate worktree. The fd-based `flock` auto-releases when its batch exits. |
| `--run latest\|<run-id>` | `status`, `integrate`, `cleanup` | Which run to act on. Default `latest`. |
| `--watch` | `status` | Poll to a terminal status (see §13.5 for exit codes). |
| `--json` | `report`, `explain`, `pick-driver` | Machine-readable output. Default: human text (on `pick-driver`, the bare driver name). |
| `--candidates <a,b>` / `--candidate <name[=pool]>` | `pick-driver` | Candidate drivers, best-liked first; repeatable. Unset → `RALPH_CRON_DRIVER_CANDIDATES`, else the profile's rung backends (§4.2). |
| `--default <name>` | `pick-driver` | Fallback when no candidate has usable live usage. Unset → whatever `RALPH_CRON_DRIVER` resolves to. |
| `--exhausted-pool <pool>` | `pick-driver` | Hold back candidates on a pool whose quota circuit is open; repeatable. |
| `--shell` | `pick-driver` | Print eval-able `RALPH_PICK_DRIVER_*` assignments instead of the bare name. |
| `--pr` | `integrate` | Push the branch + `gh pr create` instead of merging main. `Fixes #N` from the branch name; `RALPH_FIXES="1 3 4"` closes several. Keeps the branch, removes the worktree, needs `gh`. |
| `--merged` | `cleanup` | Sweep every worktree whose PR is already merged (needs `gh`). |
| `--delete-branch` | `cleanup`, `integrate` | Also delete the run branch. Default: branch kept. |
| `--keep-worktree` / `--skip-cleanup` | `integrate` | Don't auto-clean up after integrating. Default: auto-cleanup. |
| `--cleanup` | — | Accepted by the parser but **read nowhere** in `bin/ralph` today — it is inert. `integrate` already auto-cleans unless you pass `--keep-worktree`. |
| `--type generic\|nextjs-postgres` | `init-target` | Scaffold type. Default `generic`. |
| `--app-port <n>` / `--db-port <n>` | `review`, `batch` | Pin preview ports. Default: auto-allocated. |
| `--preview-host <host>` | `review`, `batch` | Hostname in the preview URL. Default `localhost`. |
| `--keep-preview-on-fail` | `review` | Leave the preview running after a failed run. Default: torn down. |
| `--complexity trivial\|small\|medium\|large` | `explain` | Which tier to explain. Required (or as a bare positional). |
| `--builder-provider` / `--builder-model` / `--builder-effort` (and `--reviewer-*`) | `review`, `batch` | Normalized selection — see §2. |
| `--profile cheap\|balanced\|max` | `review`, `batch` | Agent preset (see §2). **On `explain` and `pick-driver` only**, `--profile` instead means the efficiency profile *path*. |

Also worth knowing: `RALPH_WORKTREE_DIR` moves the worktree base (default
`<target-parent>/.ralph-worktrees`), and `RALPH_DRY_RUN=1` is the test suite's hook for
running the loops without invoking a real agent.

---

## 15. Verifying any of this yourself

`ralph help` prints the authoritative flag list. Everything above is enforced by the hermetic
suite — `npm test` — with the mode-specific gates in `tests/efficiency.mjs`,
`tests/efficiency-select.mjs`, `tests/efficiency-dispatch.mjs`, `tests/auto-escalate.mjs`,
`tests/usage-state.mjs`, `tests/pick-driver.mjs`, `tests/report.mjs`, `tests/log-usage.mjs`, `tests/cron-driver.mjs`, `tests/usage.mjs`,
`tests/usage-per-backend.mjs`, `tests/agent-selection.mjs` and `tests/integrate-identity.mjs`
(§12's PR-filing identity). The default-OFF contracts in §5
and §6 are pinned as explicit regression tests, so if a default in this document ever drifts,
those tests fail first.

Identity *resolution* itself (§12) has one more suite, `tests/identity-resolution.mjs`, which is
**not** in the `npm test` list — run it directly with `node tests/identity-resolution.mjs`.
