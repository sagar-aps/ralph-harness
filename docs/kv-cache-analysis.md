# Issue #32 — Cache-friendly prompt assembly: measurement and findings

Status: analysis only. No code changed.

## What was measured

Two corpora, used for different things.

**Primary — the Aug 2–4 archives** (`/home/sagar_ap/tmp/ralph-runs-2026-08-02.zip`,
`ralph-runs-2026-08-03-04.zip`; 586 files, 13 MB):

```
aug02   19 run dirs, BUILDER=codex / REVIEWER=codex-readonly, TASK_TOTAL=1
        32 builder prompts, of which 2 usable consecutive iter-1→iter-2 pairs
aug0304  9 run dirs, BUILDER=zlaude|claude-sonnet / REVIEWER=zlaude-haiku|claude-haiku
        9 builder prompts, all iter-1 only. 7 of 9 outcome READY_FOR_HUMAN_REVIEW
        with per-task PASS / "1 of 3" / verdict PASS — i.e. the builder succeeded
        on the first attempt, so no second attempt was ever rendered.
        2 of 9 outcome BUILDER_UNAVAILABLE (batch-20260804-031528-34422,
        claude-sonnet; batch-20260804-034444-45159, zlaude — the latter's log
        carries `429 · Usage limit reached for 5 hour`).
        Paths are /Users/…/Memorix/worktrees/… — the mac install.
```

These confirm the diagnosis directly and supply the cross-run measurement. They
cannot supply a cross-attempt ceiling — but for a benign reason: **these runs
passed first try.** That is a workload characteristic, not a failure, and it
changes where the caching prize actually is (Finding 4).

All aug02 runs are `TASK_TOTAL=1` too, so `ACCUMULATED_CONTEXT` never accumulates
anywhere in the August corpus.

**Secondary — for the multi-task ceiling only:**

```
/home/sagar_ap/homelab/life-log/.agent-run/batch-20260602-205841-3302244
  BUILDER=opencode-z  REVIEWER=codex-readonly
  23 tasks, 134 builder + 134 reviewer iterations, MAX_ITERATIONS=15
```

Older (Jun 2), but the only corpus whose shape matches a real batching session —
which is the 120M-token workload in question. `render_prompt` and the
`PROMPT_batch_*` templates are byte-identical between that run and `main`
(62613a6), so the ordering behaviour it exhibits is current. Its absolute
figures should be read as "what batching looks like", not "what August looked
like".

**No cache metadata exists in either corpus** — no `*usage*` file, no
`cache_read_input_tokens` / `cached_tokens` anywhere. The reason is not a
capability gap: **`RALPH_USAGE` is unset in every `config.resolved.env`**, so
`--output-format json` was never injected even on the claude-family runs that
support it. All cache numbers below are modeled from rendered-prompt bytes.

## Finding 1 — the builder cache does not merely under-perform, it cannot fire

The prefix is truncated at **three** successive points, not one. Measured on the
Aug 2–4 archives:

| reuse scope | shared prefix | ~tokens | truncated by |
|---|---|---|---|
| across runs (9 zlaude runs, iter-1) | **821 B** | 205 | `- Target repo: …/worktrees/<repo>-batch-<RUN_ID>` — the worktree path embeds the run ID |
| across attempts, same run (2 codex pairs) | **3247 B** | 811 | `- This is task 001 of 1.` / `- Attempt 1 of 5 for this task.` |

Both codex pairs diverge at byte 3247, at exactly those two lines:

```
…ch-20260802-121858-29805\n- This is task 001 of 1.\n- Attempt 1 of 5 for this task.\n- Check command: /
```

Within a run the worktree path is constant, so the prefix survives to 3247 B;
across runs it dies at 821 B. The prefix scales with `{{PRIMER}}` size (843 B in
the life-log run, which had a near-empty primer; 3247 B here) but is capped by
whichever dynamic line comes first.

**811 tokens is still below the minimum cacheable prefix of every provider in
the fleet**, so the ceiling doesn't matter yet:

| provider / model class | minimum cacheable prefix |
|---|---|
| Claude Opus 5 / Fable 5 | 512 tokens |
| Claude Opus 4.8, Sonnet 5, Sonnet 4.6 | 1024 tokens |
| Claude Opus 4.7 | 2048 tokens |
| Claude Opus 4.6 / 4.5, Haiku 4.5 | 4096 tokens |
| OpenAI (codex), Z.AI (opencode) implicit prefix cache | 1024 tokens |

Below the minimum a provider silently declines to cache — no error, just
`cache_creation_input_tokens: 0`. So the correct statement is not "we get a low
hit rate"; it is **the builder currently gets zero cache benefit on every
backend**, at 205 tokens cross-run and 811 tokens within a run.

### Root cause: three template lines

`.agents/ralph/PROMPT_batch_builder.md`

```
 13  ## Repo primer (orientation — read first)
 14  {{PRIMER}}                       ← stable
 16  ## Context
 17  - Target repo: {{TARGET_REPO}}   ← DYNAMIC per run (path embeds RUN_ID) (byte ~821)
 18  - Shared batch branch: {{BRANCH}} ← DYNAMIC per run (contains RUN_ID)
 19  - This is task {{TASK_NUMBER}} of {{TASK_TOTAL}}.   ← DYNAMIC per task  (byte ~3247)
 20  - Attempt {{ATTEMPT}} of {{MAX_ITERATIONS}}.        ← DYNAMIC per attempt
 26  {{PREVIOUS_REVIEW}}              ← dynamic, and the largest block
 30  {{PREVIOUS_CHECK}}               ← dynamic
 35  {{PREVIOUS_VERIFY}}              ← dynamic
 38  {{ACCUMULATED_CONTEXT}}          ← stable within a task  (~15 KB)
 41  {{TASK_CONTENT}}                 ← stable within a task  (~1.7 KB)
 43+ ## Rules / ## Steps / ## Handoff format  ← stable across the whole run (~1.5 KB)
```

Lines 17–20 truncate the prefix, and the stable-within-task content sits
*behind* the volatile blocks. This is the textbook worst case: the entire stable
bulk is stranded in the suffix.

Note line 17 in particular — the worktree path is not incidental. Because
`.ralph-worktrees/<repo>-batch-<RUN_ID>` embeds the run ID, **no two runs can
ever share a cache prefix beyond byte 821**, even with identical primer, rules,
and tasks. For someone re-running a batch after a fix, that is the difference
between a warm and a cold start on every single attempt.

`PROMPT_batch_reviewer.md` is accidentally cache-friendlier for exactly one
reason — it has no `{{ATTEMPT}}` marker at all. That is the diagnosis confirming
itself.

### Recoverable by reordering

Shared prefix (cacheable today) vs shared suffix (identical bytes stranded
behind the volatile blocks). The ceiling scales with batch depth, because
`ACCUMULATED_CONTEXT` grows with each completed task:

| corpus | shape | resent | cacheable today | stranded suffix | reorder ceiling |
|---|---|---|---|---|---|
| aug02 `…-121858` | 1 task, codex | 32 KB | 10.0 % | 23.8 % | 33.9 % |
| aug02 `…-130639` | 1 task, codex | 65 KB | 5.0 % | 11.1 % | 16.1 % |
| life-log builder | **23 tasks**, opencode-z | 15.29 MB | 0.6 % | 51.5 % | **52.1 %** |
| life-log reviewer | 23 tasks, codex-ro | 6.64 MB | 77.5 % | 10.6 % | 88.1 % |

The single-task runs understate the win: with no accumulated context there is
little stable bulk to strand. **52 % is the figure that applies to your batching
workload**; 16–34 % is what a one-task smoke run shows.

Moving lines 19–20 and the three `PREVIOUS_*` blocks after
`ACCUMULATED_CONTEXT` / `TASK_CONTENT` / `Rules` / `Steps` / `Handoff` makes
~52 % of builder input cache-eligible. At Z.AI's ~20 % cached-token rate that is
roughly a 42 % reduction in builder input cost; on Anthropic's ~10 % read rate,
~47 %.

## Finding 2 — larger than caching: PREVIOUS_REVIEW is raw CLI stdout

`batch-loop.sh:952` feeds the reviewer's **entire stdout file** to the next
builder attempt as `{{PREVIOUS_REVIEW}}`. Codex echoes its whole input prompt to
stdout before replying. That input prompt contains
`## Git diff produced by the builder for THIS task`.

This reproduces on the August runs. In the two aug02 pairs, the share of the
iter-2 builder prompt that is raw codex stdout:

| run | reviewer stdout | iter-2 builder prompt | share |
|---|---|---|---|
| `batch-20260802-121858-29805` | 20,753 B | 32,328 B | **64 %** |
| `batch-20260802-130639-51725` | 54,708 B | 65,171 B | **84 %** |

The duplicated headings are visible on inspection — `## Layout`, `## Context`,
`## Rules (non-negotiable)`, `## Fix direction`, and `## Observations for your
dispatcher` each appear **twice** in the iter-2 builder prompt, once as the
builder's own template and once inside the echoed reviewer prompt, alongside
`## Git diff produced by the builder for THIS task` (3,759 B) and the reviewer's
`## Output format` (3,509 B) that the builder has no use for.

Across the 134-iteration life-log batch the same defect averages out to:

| | bytes | ~tokens | share of builder input |
|---|---|---|---|
| builder prompt input, total | 16.47 MB | 4.12 M | 100 % |
| …of which raw codex stdout as PREVIOUS_REVIEW | 6.95 MB | 1.74 M | **42 %** |
| …of which the builder's own git diff, echoed back | 5.32 MB | 1.33 M | **32 %** |

A concrete example — `task-005-iter-6-reviewer.md` is 45,752 bytes and opens
with two `401 Unauthorized` codex auth errors, then `OpenAI Codex v0.133.0`,
then the reviewer prompt verbatim including a 31 KB diff. All 45 KB is spliced
into the next builder prompt.

So a third of every builder prompt is the builder being shown its own diff,
laundered through the reviewer's stdout, alongside provider banner noise and
auth errors. This is not a design tradeoff about keeping reviewer feedback (the
ticket rightly wants that kept) — it is a capture defect. Extracting the verdict
line plus the `### Must-fix issues` / `### Should-fix issues` sections that
`PROMPT_batch_reviewer.md:70-76` already mandates would preserve every bit of
the correctness signal.

Deletion beats caching here: a cached token still bills at 10–20 %, a deleted
token bills at 0 %. And the two levers compound — removing the volatile 32 %
shrinks the dynamic suffix, so the stable prefix becomes a larger share of what
remains.

## Finding 3 — one fix serves all providers; profiles are only needed for metrics

The ticket proposes per-provider handling, including explicit `cache_control`
breakpoints for Anthropic. **Ralph cannot set `cache_control`.** It shells out:

```
AGENT_CLAUDE_CMD="claude -p --dangerously-skip-permissions \"$(cat {prompt})\""
AGENT_OPENCODE_Z_CMD='opencode run "$(cat {prompt})"'
AGENT_CODEX_READONLY_CMD='codex exec --sandbox read-only -'
```

The rendered prompt arrives as one user-turn string. The CLI owns `system`,
`tools`, and any breakpoint placement. Ralph's only lever on any backend is the
byte order *inside* that string:

| backend | cache mechanism | ralph's lever | extra flag needed |
|---|---|---|---|
| opencode / opencode-z (Z.AI) | implicit prefix cache | token order | none |
| codex (OpenAI) | automatic prefix cache | token order | none |
| claude / rlaude / zlaude | CLI manages its own `cache_control` | token order | none — and none available |

There is no setting that "turns on" cache hits, and no per-provider prompt
profile is warranted. The reorder is provider-agnostic and helps all three. This
simplifies the ticket rather than complicating it: **one template change, no
profiles.**

Multi-install naming is already handled — `batch-loop.sh:198` defines
`RALPH_CLAUDE_LIKE="${RALPH_CLAUDE_LIKE:-claude rlaude zlaude}"`, so `zlaude`
(mac) and `rlaude` (here) are both recognized. Any cache-metric work must key
off that variable, never a hardcoded `claude`.

## Finding 4 — the reorder helps batching; it cannot help the small mac runs

Because 7 of 9 aug0304 runs passed on attempt 1, cross-*attempt* reuse is not
where their tokens go. The reuse opportunity for that workload shape is
cross-*run*: 9 runs against the same repo, same rules, same plan directory, each
starting cold.

Simulating the fix on those 9 prompts — hoisting the whole `## Context` block to
the end and recomputing the common prefix across runs:

| | common prefix across the 9 runs |
|---|---|
| today | 817 B (~204 tok) |
| after reorder | 1205 B (~301 tok) |

Still nowhere near the 1024-token minimum. The reason is a hard budget ceiling:
these prompts are only **6.8–7.5 KB total**, and the genuinely stable sections
add up to about 3.4 KB ≈ 860 tokens (`Rules` 1229 B, `Observations` 705 B,
`BLOCKED` 575 B, `Steps` 387 B, `If blocked` 334 B, `Verification` 169 B). Even a
perfect reorder that hoisted every dynamic byte would land under 1024 tokens —
clearing only Opus 5's 512-token minimum, and nothing else in the fleet.

**So the reorder's value is confined to the batching workload**, where prompts
run 4.5–205 KB and `ACCUMULATED_CONTEXT` alone reaches ~15 KB. For the small
single-task runs, caching is structurally unavailable at any ordering.

Two things fall out of this that are worth acting on independently:

1. **`{{PRIMER}}` is empty.** In these runs `## Repo primer (orientation — read
   first)` is **23 bytes** — the `(no primer provided)` fallback. That is the one
   lever that could add stable bulk to the front of every prompt on every
   backend. Populating it would improve builder grounding *and* is the cheapest
   path to pushing small-run prompts over the cacheable threshold. It needs no
   template change at all — just `R_PRIMER_FILE`.
2. **`RUN_ID` leaks in a second place.** After hoisting `## Context`, the next
   divergence is at byte 1205, inside the accumulated-context header:
   `Branch: ralph/batch-<RUN_ID>  |  Plan: /Users/…/.plans-<TIMESTAMP>-managed/…`.
   Fixing only the `## Context` block leaves this one, so the reorder must cover
   both or cross-run reuse stays broken.

## Finding 5 — provider docs change the design, not just the rationale

Read against each provider's own caching documentation (Aug 2026):

| | OpenAI / codex | Z.AI / opencode | Anthropic / claude |
|---|---|---|---|
| mechanism | automatic prefix cache | implicit prefix cache | explicit `cache_control` |
| minimum prefix | **1024 tok** | not documented | 512 / 1024 / 2048 / 4096 by model |
| match rule | **exact prefix only** | "minor formatting differences may affect cache effectiveness" | exact prefix |
| **cache-key routing** | **hash of the first ~256 tokens** (+ optional `prompt_cache_key`) | not documented | prefix |
| cached-token price | cached-input rate; **writes cost 1.25×** on GPT-5.6+ | ~18.6 % of standard on pay-per-token; **0.1×** on the Coding Plan | 0.1× read, 1.25× write (5 m) / 2× (1 h) |
| usage field | `usage.prompt_tokens_details.cached_tokens` (Chat Completions) / `usage.input_tokens_details.cached_tokens` (Responses) | `usage.prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| TTL | ≥30 min on GPT-5.6+ (`prompt_cache_options.ttl`); else 5–10 min idle, 1 h max | "reasonable time limits", unspecified | 5 min default, 1 h opt-in |
| documented best practice | *"Structure prompts with static or repeated content at the beginning and dynamic, user-specific content at the end."* | identical-prefix recognition | stable content first |

Note the Z.AI **caching guide** says cached tokens bill at "usually 50 % of
standard price", but its **pricing** pages put GLM-5.2 cached input at
$0.26 vs $1.40 (≈18.6 %) and the Coding Plan at 0.1×. The ticket's ~20 %
premise is right; the guide's 50 % is stale generic wording. Treat the pricing
page as authoritative.

### The cache-key window changes the diagnosis for codex

OpenAI routes on a hash of roughly the **first 256 tokens**. Anything dynamic
inside that window doesn't merely shorten the prefix — it lands the request in a
**different cache bucket entirely**. Measured against a real builder prompt,
ralph has two dynamic markers inside that window, and one of them I had missed:

| byte | ≈tok | marker | in key window? |
|---|---|---|---|
| ~448 | **~110** | `{{MAX_ITERATIONS}}` — *"You get up to N attempt(s)"*, line 8, **before the primer** | **yes** |
| ~821 | ~205 | `{{TARGET_REPO}}` — worktree path embeds `RUN_ID` | **yes** |
| ~860 | ~215 | `{{BRANCH}}` — embeds `RUN_ID` | **yes** |
| ~3247 | ~811 | `{{TASK_NUMBER}}` / `{{TASK_TOTAL}}` / `{{ATTEMPT}}` | no |

`{{MAX_ITERATIONS}}` demonstrably varies across the archives — `5` in the 21
aug02 runs, `3` in the 9 aug0304 runs — so changing `--max-iterations` between
runs silently changes the cache bucket on codex.

So there are **two independent failures on OpenAI**, not one:

1. **Routing miss** — `MAX_ITERATIONS`, worktree path and branch sit inside the
   ~256-token key window, so no two runs share a bucket.
2. **Below threshold** — even within one run the prefix caps at ~811 tokens,
   under the 1024-token minimum.

### Design constraints this imposes

- **Moving the `## Context` block is not sufficient.** `{{MAX_ITERATIONS}}` is
  embedded in the intro *prose* at ~110 tokens, ahead of everything. It has to be
  rewritten out of that paragraph (or the attempt budget stated only in the
  dynamic suffix) or the first 256 tokens still differ per run. A naive
  block-move fix passes an attempt-to-attempt diff test and still misses.
- **Target the first 256 tokens explicitly.** The gate should assert byte
  identity over the first ~1 KB across runs, not only "up to the first dynamic
  marker" — those are different assertions and only the former protects codex
  routing.
- **`prompt_cache_key` is worth investigating.** OpenAI accepts an explicit
  cache-routing key. `agents.sh` already passes codex config through
  (`codex exec -c model_reasoning_effort=…`), so `-c prompt_cache_key=<repo>`
  may be plumbable — which would pin routing per *repo* instead of per *run* and
  fix failure (1) independently of ordering. Unverified; needs a codex-CLI check.
- **Z.AI's "minor formatting differences" wording is a caution.** Its matcher is
  documented less strictly than OpenAI's "exact prefix". Don't assume Z.AI
  tolerance justifies a looser gate — hold the strict byte-identical standard,
  which satisfies all three providers.
- **Anthropic remains ordering-only for ralph.** `cache_control` needs API
  access ralph doesn't have (Finding 3). Ordering is still the whole lever there.

## Measurement: what is actually reportable

| provider / CLI | cache field | how to get it | verdict |
|---|---|---|---|
| claude / rlaude / zlaude | `cache_read_input_tokens`, `cache_creation_input_tokens` | `--output-format json`, already injected by `RALPH_USAGE` for anything in `RALPH_CLAUDE_LIKE`; `extract_usage()` already writes the sidecar | **available** |
| codex | `cached_tokens` | codex stdout is human-readable prose; no JSON usage mode found | `unknown` |
| opencode / opencode-z | `cached_tokens` | opencode stdout likewise; Z.AI usage API would be an out-of-band call (#27) | `unknown` |

**The measurement leg is closer than the ticket assumes.** It is blocked by
configuration, not capability: `RALPH_USAGE` is unset in all 28 archived runs, so
`--output-format json` was never injected — including on the 6 `zlaude` and 1
`claude-sonnet` runs that would have reported cache fields. Setting
`RALPH_USAGE=1` on a claude-family run is the whole prerequisite; `extract_usage()`
already parses the JSON and writes the sidecar.

Two caveats on that path:

- `zlaude` is a claude-CLI wrapper pointed at Z.AI (issue #31). Whether Z.AI's
  Anthropic-compatible endpoint populates `cache_read_input_tokens` in
  `--output-format json` is untested. **`rlaude`/`claude` against real Anthropic
  is the trustworthy first measurement**, and `claude-sonnet` already appears as a
  configured builder (`batch-20260804-031528-34422`), so no new setup is needed.
- The archived claude-family builder logs open with
  `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY … is set` — the
  known #22/#25 signature. Unset `ANTHROPIC_API_KEY` in the wrapper before
  trusting any measurement taken through it.

## Recommended acceptance

The ticket's provider-free gate is the right core and is achievable today with
no provider spend. Two adjustments:

1. Assert the shared prefix is **≥ 1024 tokens**, not merely byte-identical. A
   byte-identical 811-token prefix passes a diff test and still caches nowhere —
   that is precisely today's state. 1024 covers every backend in the fleet
   except Opus 4.6/4.5 and Haiku 4.5 (4096); worth a note in the test comment.
2. Assert the prefix is identical **across runs**, not just across attempts
   within one run. Today that case fails at 821 B because of the worktree path,
   and an attempts-only test would pass while cross-run reuse stays broken.
3. Add a regression assertion that no `PROMPT_*` template places a dynamic
   marker before the end of the stable block, so the fix cannot silently rot.

## Implementation result (reorder + gate slice)

Both `PROMPT_batch_*.md` templates reordered into stability tiers — invariant prose
→ primer → rules/steps/blocked → per-run context → per-task → **dynamic boundary**
→ attempt + `PREVIOUS_*`. `tests/prompt-cache-prefix.mjs` added to `npm test`.

Measured on one identical fixture (60-line primer, 1 task, forced 2 attempts),
before vs after:

| | before | after |
|---|---|---|
| prompt size | 10,700 B | 11,540 B (+7.9 %) |
| cross-**attempt** stable prefix | 5,954 B (~1,488 tok) | **10,923 B (~2,730 tok)** |
| cross-**run** stable prefix | 409 B (~102 tok) | **8,748 B (~2,187 tok)** |

Two honest observations:

1. **Cross-attempt caching was already possible before the reorder** on a fixture
   with a large primer — 1,488 tok clears the 1024 minimum. The reorder nearly
   doubles it, but the qualitative change is cross-**run**: 102 → 2,187 tokens,
   i.e. from structurally impossible to comfortably above threshold on every
   backend. That is the OpenAI bucket-routing fix.
2. **The prompt grew 840 B** (the boundary comments and the new `## Attempt`
   heading). Raw size went up; effective cost went down. On this fixture, at a
   0.1× cached-read rate the warm-cache input cost falls ~68 % cross-attempt
   (5,341 → 1,709 B-equivalent) and ~66 % cross-run (10,700 → 3,667), because the
   cacheable share rises from 56 % to 95 %.

### The gate is not vacuous

Verified by reintroducing the exact pre-#32 defect — putting `{{MAX_ITERATIONS}}`
back into the intro prose — which collapses the cross-run prefix to 409 B and
fails the suite. Notably the **cross-attempt assertions still passed** in that
state, because within a single run the attempt budget is constant. So the
acceptance's attempt-to-attempt gate alone would *not* have caught it; the
cross-run test is what pins the regression. That asymmetry is the main argument
for keeping test 3.

### Deliberate deviations from a pure reorder

- `{{MAX_ITERATIONS}}` was removed from the intro sentence and now renders only in
  the dynamic `## Attempt` block. The placeholder is preserved, just relocated —
  it cannot stay in the intro without defeating the whole exercise, since it sits
  at ~110 tokens inside OpenAI's cache-key window.
- Two HTML comments were added marking the boundary and warning against moving
  dynamic content upward. They cost ~500 B of prompt and are the only thing
  telling a future editor that the ordering is load-bearing.

### Known limit, not addressed here

The cross-run prefix still terminates where the first run-scoped path appears —
`{{AGENTS_PATH}}` / `{{CHECK_CMD}}` are referenced inside the Rules block, and the
worktree path embeds `RUN_ID`. Pushing those references out (e.g. Rules pointing at
"the check command listed under Context") would extend the cross-run prefix
further, but it is rewording rather than reordering and was left out of this
slice.

## Sequencing

Per the owner's decision, #32 lands after everything up to and including it. The
evidence supports that ordering, and the archives sharpen why:

- **#26 / #27** own the reporting surface where cache metrics would display.
- **#35 / #33** (preflight fork-bomb, no-backoff hot loop) are what killed the
  local Linux runs — 418 dirs at exit 137 — so a local end-to-end measurement
  needs them first. The mac runs were unaffected.
- **#28 is _not_ a blocker here.** 7 of 9 aug0304 runs completed
  READY_FOR_HUMAN_REVIEW; only 2 hit BUILDER_UNAVAILABLE, one of them on a 429.
  Quota is a real cost concern but it is not what stands between us and a cache
  measurement.

What actually gates the measurement leg is workload shape, not any of the above:
a cache hit needs a ≥1024-token stable prefix, and per Finding 4 the small
single-task runs cannot produce one. **Measure on a multi-task batch run with
`RALPH_USAGE=1` and a non-empty primer**, on `claude`/`rlaude` against real
Anthropic. Anything smaller will report zero and prove nothing.

The reorder itself is independent of all of it and testable offline with no
provider spend, so it can land whenever its slot comes up.

The PREVIOUS_REVIEW capture defect (Finding 2) is worth splitting into its own
ticket. It is a larger token win than the caching reorder, it is independent of
every dependency above, and framing it as part of a caching ticket will bury it.
