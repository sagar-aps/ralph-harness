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
        9 builder prompts, all iter-1 only — every run died at
        `API Error: Request rejected (429) · Usage limit reached for 5 hour`
        (issue #28). Paths are /Users/…/Memorix/worktrees/… — the mac install.
```

These confirm the diagnosis directly and supply the cross-run measurement. They
cannot supply a deep multi-task iteration ceiling: all aug02 runs are
`TASK_TOTAL=1`, so `ACCUMULATED_CONTEXT` is always `(this is the first task)`,
and the zlaude runs produced no second iteration to compare.

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

## Sequencing

Per the owner's decision, #32 lands after everything up to and including it. The
evidence supports that ordering, and the archives sharpen why:

- **#28 (provider quota circuit-break) is the binding constraint on measurement.**
  All 9 aug0304 runs died at `429 · Usage limit reached for 5 hour` after
  producing exactly one builder prompt and no output. You cannot observe a cache
  hit across attempts when the run never reaches attempt 2.
- **#35 / #33** (preflight fork-bomb, no-backoff hot loop) are what killed the
  local runs — 418 dirs at exit 137.
- **#26 / #27** own the reporting surface where cache metrics would display.

The reorder itself is independent of all of them and is testable offline with no
provider spend, so it can land whenever its slot comes up; only the measurement
leg waits.

The PREVIOUS_REVIEW capture defect (Finding 2) is worth splitting into its own
ticket. It is a larger token win than the caching reorder, it is independent of
every dependency above, and framing it as part of a caching ticket will bury it.
