# Token Economics — caching, pricing, usage

Read this before you reason about token cost, prompt caching, or "will this reduce
spend" in this repo. A single batch here can consume hundreds of millions of tokens,
so wrong assumptions are expensive — and most of the intuitive assumptions in this
area turn out to be wrong.

**Everything below was measured, not inferred, on 2026-08-04** (codex-cli 0.146.0,
claude CLI, opencode 1.15.13). Provider behaviour changes; the "How to verify"
section exists so you can re-run each claim rather than trusting this file.
If a measurement here contradicts what you observe, trust your measurement and
update this file.

---

## 1. The one thing to know

**Prompt caching works on the claude family and on Z.AI, and does not work on codex.**

| backend | caches the prompt *we* send? | evidence |
|---|---|---|
| `claude` / `rlaude` / `zlaude` | **yes — the whole prompt** | run 1 `cache_creation_input_tokens: 10246`; run 2 `cache_read_input_tokens: 18089` on the identical prompt |
| `codex` / `codex-readonly` | **no** | identical prompt ×3 → `cached_input_tokens` pinned at 11,008 every time (that's codex's *own* system prefix, not ours) |
| `opencode` / `opencode-z` (Z.AI) | **yes — implicit, provider-side** | identical prompt → `cache_read_input_tokens` 0 → **3,200** of 3,259 input tokens, measured against the Z.AI endpoint directly (the `opencode` CLI itself is unverified — it hangs, #44) |

Why codex doesn't: it appears to derive its internal `prompt_cache_key` from
`thread_id`, and every `codex exec` is a new thread. Caching *does* accumulate
within one thread (`resume`: 11,008 → 22,016 → 43,264), but `resume` re-sends the
whole conversation each turn so uncached tokens *grow* (5,773 → 16,662 → 20,586).
It is not a usable optimisation. See #39.

**Consequences for how you work:**

- Do not promise cache savings on a codex-backed run. There are none.
- If a workload is retry-heavy and caching is the lever you want, that argues for a
  claude-family builder (Anthropic **or** Z.AI-backed). See the role-selection guidance
  in the Manager charter.
- Z.AI's caching is **implicit** — no `cache_control`, nothing to configure. Byte-stable
  prefixes are the whole mechanism, which is why prompt ordering matters there.
- `prompt_cache_key` is **not settable** from ralph. `codex exec -c prompt_cache_key=…`
  is rejected as an unknown config field.

---

## 2. Deleting tokens beats caching tokens

A cached token still bills at 10–20 % of full rate. A token you don't send bills at
**0 %**, on every provider, with no cache-hit precondition.

So when you find redundancy, prefer removing it over making it cacheable. The
largest single win in this repo's history was exactly this: builder retries were
being fed the reviewer's entire raw stdout, which (because codex echoes its input
prompt) round-tripped the builder's own git diff back to it. That was **64–84 % of a
retry prompt**. Fixed by extracting the findings block (#41).

Before optimising a prompt for caching, check whether the content needs to be there
at all.

**Version caveat on that example.** The 64-84 % figures come from archived runs on
codex **0.133.0 / 0.145.0**, which echoed the input prompt to stdout. Codex **0.146.0
does not** — a 12,006 B prompt produced 3 bytes of stdout. So on current codex that
particular win is ~nil; the extraction remains as version-defence (older codex, other
CLIs) and as a cap on runaway reviewer output. Measure your own CLI version before
quoting a saving.

---

## 3. Provider facts

| | OpenAI / codex | Z.AI / opencode | Anthropic / claude |
|---|---|---|---|
| mechanism | automatic prefix cache | implicit prefix cache | explicit `cache_control` (the CLI sets it) |
| minimum cacheable prefix | **1024 tok** | not documented | 512 / 1024 / 2048 / 4096 **depending on model** |
| match rule | exact prefix only | "minor formatting differences may affect cache effectiveness" | exact prefix |
| cache-key routing | **hash of first ~256 tokens** (+ `prompt_cache_key`) | not documented | prefix |
| cached-token price | cached-input rate | ~18.6 % pay-per-token; **0.1× on the Coding Plan** | 0.1× read; 1.25× write (5 m) / 2× (1 h) |
| TTL | ≥30 min (GPT-5.6+); else 5–10 min idle, 1 h max | unspecified | 5 min default, 1 h opt-in |

Traps in that table:

- **Anthropic's minimum is not monotonic** — 512 tokens on the newest models but 4096
  on Opus 4.6/4.5 and Haiku 4.5. "It cached on model X" does not imply model Y.
- **Z.AI's own docs disagree with themselves.** The caching guide says cached tokens
  bill at "usually 50 %"; the pricing pages say $0.26 vs $1.40 (≈18.6 %) and the
  Coding Plan says 0.1×. **Treat the pricing page as authoritative.**
- **OpenAI's ~256-token cache-key window** means a dynamic token near the top of a
  prompt is not "a slightly shorter prefix" — it is a *different cache bucket*.

---

### Z.AI endpoint routing (a trap)

The GLM **Coding Plan** credential is scoped to the Anthropic-compatible endpoint
(`https://api.z.ai/api/anthropic/v1/messages`). Sending it at the pay-per-token
OpenAI-shaped route (`/api/paas/v4/chat/completions`) returns
`1113: Insufficient balance or no resource package` — which reads like a billing
problem and is actually a wrong-endpoint problem. `GET /api/paas/v4/models` *does*
answer with the Coding Plan key, so a successful model list is not evidence that
inference will work.

## 4. Reading usage from each CLI

All three have a JSON mode. Field names differ from the underlying APIs — use these,
not the provider docs' names.

Usage capture is **on by default** (`RALPH_USAGE=0` to disable). It is safe to default
because an unrecognised JSON shape is salvaged rather than left to break the verdict
grep: the harness recovers any `text` values, rewrites the log so `^VERDICT:` still
matches, writes no sidecar, and warns that metrics were skipped. A CLI renaming its
events therefore costs metrics, never a run.

| backend | flag | cache-read field | cache-write field |
|---|---|---|---|
| claude family | `--output-format json` | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` |
| codex | `--json` (JSONL; usage on the final `turn.completed` event) | `cached_input_tokens` | `cache_write_input_tokens` |
| opencode | *(not instrumented — see below)* | — | — |

Two cautions:

1. **`codex --json` / `claude --output-format json` change stdout to JSON, which
   breaks the reviewer's `^VERDICT:` grep.** That failure mode is silent and
   expensive: no verdict match → `REVIEWER_UNAVAILABLE` → retries until
   `MAX_ITERATIONS`. `extract_usage()` in `batch-loop.sh` exists to extract the text
   back out before the grep. Never inject a JSON flag into a reviewer command without
   that extraction path.
2. **`codex`'s `cache_write_input_tokens` is always `0`** — including on calls where
   `cached_input_tokens` demonstrably grew. It is unpopulated on this path and carries
   **no information**. Do not conclude "nothing was cached" from it. (I made this
   mistake; `cached_input_tokens` is the load-bearing field.)
3. **The flag belongs to the CLI, not to the `env` wrapper in front of it.** Model-pinned
   aliases are usually `env -u ANTHROPIC_API_KEY … claude-sonnet -p …`, and injecting
   after the first token yields `env --output-format json … claude-sonnet …`. GNU env
   calls that an unrecognised option and macOS/BSD env calls it `illegal option -- o`;
   either way the agent exits 1 every attempt and the run dies as
   `builder backend unavailable`. `add_json_flag` therefore walks past env's own
   arguments (`-u NAME`, `-i`, `-`, `VAR=value`, …) to the real executable and injects
   after that — and if the executable behind `env` is not a claude CLI it injects
   nothing at all (#72).

**opencode is deliberately left uninstrumented.** It accepts `--format json`, but its
usage field names are unverified while #44 blocks testing, and injecting a flag whose
output shape we cannot parse would leave the verdict grep staring at JSON — silently
burning every attempt. Unknown beats broken. Revisit when #44 lands.

**Z.AI reports reads but not creations.** On the Z.AI Anthropic-compatible endpoint
`usage` carries `cache_read_input_tokens` but **omits `cache_creation_input_tokens`
entirely** (keys observed: `cache_read_input_tokens`, `input_tokens`, `output_tokens`,
`server_tool_use`, `service_tier`). Code that assumes the creation field exists will
read `None`. That also confirms `zlaude` — claude-CLI pointed at this endpoint — does
report cache reads, which was previously an open question.

Key off `RALPH_CLAUDE_LIKE` / `RALPH_CODEX_LIKE` rather than hardcoding binary names — `rlaude` and
`zlaude` are claude-CLI wrappers. `zlaude` is claude-CLI pointed at Z.AI; it **does**
report `cache_read_input_tokens` (measured against that endpoint), but **not**
`cache_creation_input_tokens`.

---

## 5. Prompt assembly rules (enforced by tests)

`PROMPT_batch_builder.md` and `PROMPT_batch_reviewer.md` are ordered
**most-stable-first**, with a `DYNAMIC BOUNDARY` marker:

```
invariant prose → primer → rules/steps/blocked → per-run context → per-task
──────────────── DYNAMIC BOUNDARY ────────────────
attempt N → PREVIOUS_REVIEW / PREVIOUS_CHECK / PREVIOUS_VERIFY
```

**If you edit a prompt template, the ordering is load-bearing.** One dynamic token
above the boundary invalidates every cached token beneath it.
`tests/prompt-cache-prefix.mjs` will fail you. Specifically:

- Never put a placeholder that varies per run or per attempt above the boundary.
- Watch **prose**, not just placeholder blocks. The original bug was
  `{{MAX_ITERATIONS}}` inside an intro *sentence* at ~110 tokens — inside OpenAI's
  key window, ahead of everything.
- `RUN_ID` leaks in three places: the worktree path (`{{TARGET_REPO}}`),
  `{{BRANCH}}`, and the accumulated-context header. Fixing one leaves the others.

### Identity is not sufficient — check length too

A byte-identical prefix below the provider minimum caches **nowhere**, silently. The
pre-fix state was a byte-identical ~811-token prefix that cached on no backend. Any
gate must assert *both* identity and a ≥1024-token floor.

### Small runs cannot be made cacheable

Single-task runs render ~7 KB prompts whose stable sections total ~860 tokens — under
the 1024 minimum even after perfect ordering. No amount of reordering fixes that.
**The primer is the lever**: `{{PRIMER}}` is the main body of run-invariant content at
the front of the prompt. An empty primer (`(no primer provided)` — 23 bytes) means
both worse grounding and an uncacheable prompt. Set `.primer` in
`ralph.target.json`, or pass `--primer`.

---

## 6. How to verify any of this yourself

Cheap, and worth doing before you trust a claim in this file.

**Does a backend cache our prompt?** Send the *identical* large prompt twice and
compare cache fields. Growth means it caches; a flat number means it does not.

```sh
# codex — needs a git dir; config validation runs before any API call
printf 'reply with exactly: ok\n' > /tmp/p.txt
codex exec --json --skip-git-repo-check --sandbox read-only - < /tmp/p.txt \
  | grep '"turn.completed"'

# claude — cache_creation on run 1, cache_read on run 2
env -u ANTHROPIC_API_KEY claude -p --output-format json "$(cat /tmp/p.txt)"
```

**Is a config key supported?** Free — validation precedes the API call:

```sh
codex exec --strict-config -c some_key=1 -  # "unknown configuration field" = unsupported
```

Always include a known-bad control (`-c definitely_not_a_key=1`) and a known-good one
(`-c model=…`) so you can tell rejection from a different failure.

**Is a prefix actually stable?** Diff the rendered artifacts — no provider spend:

```sh
cmp <(cat run/task-001-iter-1-builder-prompt.md) <(cat run/task-001-iter-2-builder-prompt.md)
```

`node tests/prompt-cache-prefix.mjs` does this properly, including across runs.

---

## 7. Claims to be suspicious of

Each of these was believed here and turned out to be wrong. If you catch yourself
asserting one, measure first.

| Plausible claim | Reality |
|---|---|
| "Stable prefixes will cut cost on all backends" | codex doesn't cache caller content at all |
| "codex/opencode can't report usage" | both have JSON modes; codex's cache fields are readable today |
| "`cache_write: 0` means nothing was cached" | that field is unpopulated on codex; meaningless |
| "Byte-identical prefix ⇒ cache hit" | not below the provider minimum — it fails silently |
| "Z.AI cached tokens cost 50 %" | ~18.6 % pay-per-token, 0.1× on the Coding Plan; the guide page is stale |
| "Z.AI needs `cache_control` like Anthropic" | no — it caches implicitly; ordering is the whole lever |
| "A Coding Plan key works on any Z.AI endpoint" | it is scoped to the Anthropic-compatible route; the pay-per-token route answers `1113 Insufficient balance` |
| "`/models` answered, so inference will work" | `/models` succeeds on the Coding Plan key even where inference is refused |
| "Reordering the Context block is enough" | dynamic tokens hide in intro *prose* too |
| "Newer model ⇒ smaller cache minimum" | Anthropic's minimums are non-monotonic |
| "The reviewer log is the reviewer's findings" | it may be mostly our own echoed prompt |

---

## 8. Where the detail lives

- `docs/kv-cache-analysis.md` — full measurement trail: archived-run analysis, the
  provider-doc reading, before/after numbers, and caveats on each.
- Issue #32 — design trace for the prompt-assembly reorder.
- Issue #39 — the codex caching investigation and why thread reuse isn't a fix.
- Issue #40 — wiring per-backend usage capture into `RALPH_USAGE`.
- Issue #41 — the reviewer-stdout echo fix.
