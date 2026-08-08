// Tests for the read-only per-pool usage-state reader (#60).
//
// The reader turns .ralph/ledger.jsonl into per-pool 5h + weekly token sums. The
// contract under test is mostly about what it REFUSES to do: it only reports a
// percentage when the profile configures a token budget for that pool + window,
// it never writes anything, and it never calls a provider API. `ralph explain`
// then consumes those real numbers instead of assuming 0%.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");
const templateDir = path.join(repoRoot, ".agents", "ralph");
const helperSh = path.join(templateDir, "usage-state.sh");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
}

// ── Fixture ───────────────────────────────────────────────────────────────
// "now" for every run below unless stated otherwise: Monday 2026-08-10 11:00 UTC.
const NOW = "2026-08-10T11:00:00Z";
// The weekly window is anchored at Wed 2026-08-05 09:00 UTC, so at NOW it runs
// [2026-08-05T09:00Z, 2026-08-12T09:00Z).
const ANCHOR = "2026-08-05T09:00:00Z";

const ledgerLine = (timestamp, total, builder = "zlaude", reviewer = builder) => JSON.stringify({
  run_id: "run-A",
  round: "task-001",
  timestamp,
  agents: { builder: { provider: builder }, reviewer: { provider: reviewer } },
  invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
  tokens: { input: total, output: 0, cached: 0, total },
});

const LEDGER = [
  ledgerLine("2026-08-10T10:00:00Z", 5000),   // 1h ago  -> 5h + weekly
  ledgerLine("2026-08-10T07:30:00Z", 3000),   // 3.5h ago-> 5h + weekly (oldest in 5h)
  ledgerLine("2026-08-09T10:00:00Z", 30000),  // 25h ago -> weekly only
  ledgerLine("2026-08-04T10:00:00Z", 99999),  // before the weekly anchor -> neither
  ledgerLine("2026-08-10T09:00:00Z", 1234, "codex", "codex-readonly"), // openai pool
  ledgerLine("2026-08-10T09:30:00Z", 777, "mystery-backend"),          // no profile pool
].join("\n") + "\n";

// zai: 5h = 5000 + 3000 = 8000; weekly = 8000 + 30000 = 38000.
const ZAI_5H = 8000;
const ZAI_WEEKLY = 38000;

function profile({ budgets = true, anchor = true, fiveHourBudget = 20000 } = {}) {
  const zaiCap = { window_5h_pct: 70, window_weekly_pct: 45 };
  if (budgets) {
    zaiCap.window_5h_budget_tokens = fiveHourBudget;
    zaiCap.window_weekly_budget_tokens = 100000;
  }
  if (anchor) zaiCap.weekly_reset_anchor = ANCHOR;
  return {
    rungs: [
      {
        name: "zlaude",
        builder: { backend: "zlaude", pool: "zai" },
        reviewer: { backend: "zlaude", pool: "zai" },
        caps: { zai: zaiCap },
        avoid_windows: [{
          from: "06:00", to: "10:00", tz: "UTC", days: "Mon-Fri",
          reason: "3x quota burn (Z.AI peak)",
        }],
      },
      {
        name: "codex",
        builder: { backend: "codex", pool: "openai" },
        reviewer: { backend: "codex-readonly", pool: "openai" },
        caps: { openai: { source: "provider" } },
      },
    ],
    reserves: { near_weekly_reset_hours: 5 },
    tiers: {
      trivial: ["zlaude", "codex"], small: ["zlaude", "codex"],
      medium: ["zlaude", "codex"], large: ["zlaude", "codex"],
    },
  };
}

function makeTarget(prof = profile(), ledger = LEDGER) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-usage-"));
  mkdirSync(path.join(target, ".agents", "ralph"), { recursive: true });
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  writeFileSync(path.join(target, ".agents", "ralph", "efficiency.json"),
    typeof prof === "string" ? prof : JSON.stringify(prof, null, 2));
  if (ledger !== null) writeFileSync(path.join(target, ".ralph", "ledger.jsonl"), ledger);
  return target;
}

const cleanEnv = (env = {}) => ({
  ...process.env,
  RALPH_SKIP_UPDATE_CHECK: "1",
  RALPH_NO_LOCAL_CONFIG: "1",
  // Scrub anything an outer ralph run exported, so the fixture decides everything.
  TARGET_REPO: "", PRD_PATH: "", TASK_ID: "", TASK_INDEX: "", BRANCH: "",
  BUILDER: "", REVIEWER: "", RALPH_PROFILE: "",
  RALPH_EFFICIENCY: "", RALPH_EFFICIENCY_PROFILE: "", RALPH_EFFICIENCY_NOW: "",
  ...env,
});

// The bash entry point (usage-state.sh) is the supported shell interface.
const usageState = (target, args = [], env = {}) =>
  spawnSync("bash", [helperSh, "--repo", target, ...args], { encoding: "utf-8", env: cleanEnv(env) });

const usageStateJson = (target, env = {}) => {
  const r = usageState(target, ["--json"], env);
  if (r.status !== 0) throw new Error(`usage-state failed (${r.status}): ${r.stderr}`);
  return JSON.parse(`${r.stdout}`);
};

const ralph = (args, env = {}) =>
  spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf-8", env: cleanEnv(env) });

const recordFor = (state, pool, window) =>
  state.records.find((r) => r.pool === pool && r.window === window);

// ── 1) Seeded ledger + budgets -> exact per-pool tokens and pct ───────────
console.log("1) seeded ledger + profile budgets -> expected per-pool tokens + pct");
{
  const target = makeTarget();
  try {
    const state = usageStateJson(target, { RALPH_EFFICIENCY_NOW: NOW });
    const zai5h = recordFor(state, "zai", "5h");
    const zaiWeek = recordFor(state, "zai", "weekly");

    check(state.pools.join(",") === "zai,openai", "reports every pool the rungs reference");
    check(zai5h.used_tokens === ZAI_5H && zai5h.records === 2,
      `zai 5h window sums only the last 5h (${ZAI_5H} tokens over 2 records)`);
    check(zaiWeek.used_tokens === ZAI_WEEKLY && zaiWeek.records === 3,
      `zai weekly window sums the anchored week (${ZAI_WEEKLY} tokens over 3 records)`);
    check(zai5h.budget_tokens === 20000 && zai5h.pct === 40,
      "zai 5h pct = 8000/20000 = 40%");
    check(zaiWeek.budget_tokens === 100000 && zaiWeek.pct === 38,
      "zai weekly pct = 38000/100000 = 38%");
    check(zai5h.source === "ledger" && zaiWeek.source === "ledger",
      "records name the ledger as their source");
    check(state.ledger === path.join(target, ".ralph", "ledger.jsonl"),
      "reports which ledger it read");

    // Attribution: the profile's own backend->pool map wins, and a backend the
    // profile does not know is reported rather than silently counted.
    const openai5h = recordFor(state, "openai", "5h");
    check(openai5h.used_tokens === 1234 && openai5h.records === 1,
      "a codex round lands in the openai pool via the profile's backend map");
    check(state.notes.some((n) => /mystery-backend/.test(n)),
      "an unmapped ledger provider is called out in the notes");
    check(!state.records.some((r) => String(r.used_tokens).includes("777")),
      "an unmapped provider's tokens are attributed to no pool");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 2) No budget configured -> pct unknown, raw tokens still reported ─────
console.log("2) a pool with no configured budget -> pct unknown, tokens still reported");
{
  const target = makeTarget();
  try {
    const state = usageStateJson(target, { RALPH_EFFICIENCY_NOW: NOW });
    for (const window of ["5h", "weekly"]) {
      const rec = recordFor(state, "openai", window);
      check(rec.budget_tokens === null, `openai ${window}: no budget in the profile -> budget_tokens null`);
      check(rec.pct === "unknown", `openai ${window}: pct is unknown, never fabricated`);
      check(typeof rec.used_tokens === "number", `openai ${window}: raw tokens are still reported`);
    }
    check(state.notes.some((n) => /no window token budget configured for: openai/.test(n)),
      "says which pools have no budget and how to configure one");

    // Same ledger, a profile with NO budgets at all -> every pct unknown.
    const bare = makeTarget(profile({ budgets: false }));
    try {
      const bareState = usageStateJson(bare, { RALPH_EFFICIENCY_NOW: NOW });
      check(bareState.records.every((r) => r.pct === "unknown"),
        "with no budgets anywhere, every pct is unknown");
      check(recordFor(bareState, "zai", "5h").used_tokens === ZAI_5H,
        "…and the raw 5h token count is still reported");
    } finally { rmSync(bare, { recursive: true, force: true }); }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 3) Reset proximity: 5h roll-off, weekly anchor, near-weekly-reset ─────
console.log("3) reset proximity: 5h roll-off, weekly anchor, near-weekly-reset");
{
  const target = makeTarget();
  try {
    const state = usageStateJson(target, { RALPH_EFFICIENCY_NOW: NOW });
    const zai5h = recordFor(state, "zai", "5h");
    const zaiWeek = recordFor(state, "zai", "weekly");
    check(zai5h.reset_at === "2026-08-10T12:30:00Z" && zai5h.reset_basis === "oldest_record_rolloff",
      "5h reset = when the oldest in-window record (07:30) ages out (12:30)");
    check(zaiWeek.reset_at === "2026-08-12T09:00:00Z" && zaiWeek.reset_basis === "weekly_anchor",
      "weekly reset = the next occurrence of the profile's anchor");
    check(zaiWeek.near_weekly_reset === false,
      "46h from the reset is not 'near' (near_weekly_reset_hours=5)");

    // 4h before the weekly reset -> near.
    const near = usageStateJson(target, { RALPH_EFFICIENCY_NOW: "2026-08-12T05:00:00Z" });
    check(recordFor(near, "zai", "weekly").near_weekly_reset === true,
      "4h before the anchored reset, near_weekly_reset is true");

    // No anchor configured -> rolling 7d and an unknown reset, never invented.
    const noAnchor = makeTarget(profile({ anchor: false }));
    try {
      const s = usageStateJson(noAnchor, { RALPH_EFFICIENCY_NOW: NOW });
      const week = recordFor(s, "zai", "weekly");
      check(week.reset_at === "unknown" && week.reset_basis === "rolling_7d",
        "with no weekly anchor the reset is unknown and the window is a rolling 7d");
      check(week.near_weekly_reset === "unknown",
        "near_weekly_reset is unknown without an anchor");
      check(week.used_tokens === ZAI_WEEKLY + 99999,
        "the rolling 7d window covers a different set of records than the anchored one");
    } finally { rmSync(noAnchor, { recursive: true, force: true }); }

    // An empty 5h window has nothing to roll off.
    const quiet = usageStateJson(target, { RALPH_EFFICIENCY_NOW: "2026-08-11T23:00:00Z" });
    const quiet5h = recordFor(quiet, "zai", "5h");
    check(quiet5h.used_tokens === 0 && quiet5h.reset_at === "unknown"
      && quiet5h.reset_basis === "no_records_in_window",
      "an empty 5h window reports 0 tokens and no roll-off");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 4) avoid_window active vs inactive, from the current UTC day + time ───
console.log("4) avoid_window active-now is evaluated from the profile + current UTC");
{
  const target = makeTarget();
  try {
    // Monday 07:00 UTC is inside 06:00-10:00 Mon-Fri.
    const active = usageStateJson(target, { RALPH_EFFICIENCY_NOW: "2026-08-10T07:00:00Z" });
    const zlaude = active.rungs.find((r) => r.rung === "zlaude");
    check(zlaude.in_avoid_window === true && zlaude.avoid_windows[0].active === true,
      "Monday 07:00 UTC: the zlaude rung's avoid window is ACTIVE");
    check(recordFor(active, "zai", "5h").in_avoid_window === true,
      "the pool behind that rung is flagged in_avoid_window");
    check(recordFor(active, "openai", "5h").in_avoid_window === false,
      "a pool whose rung has no avoid window is not flagged");

    // Same time of day on Saturday: the window is Mon-Fri only.
    const weekend = usageStateJson(target, { RALPH_EFFICIENCY_NOW: "2026-08-08T07:00:00Z" });
    check(weekend.rungs.find((r) => r.rung === "zlaude").in_avoid_window === false,
      "Saturday 07:00 UTC: the Mon-Fri window does not apply");

    // Monday 11:00 UTC is past the window.
    const after = usageStateJson(target, { RALPH_EFFICIENCY_NOW: NOW });
    check(after.rungs.find((r) => r.rung === "zlaude").in_avoid_window === false,
      "Monday 11:00 UTC: the window is over, not active");
    check(recordFor(after, "zai", "weekly").in_avoid_window === false,
      "…and the pool is no longer flagged");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 5) ralph explain consumes the real numbers instead of assuming 0% ─────
console.log("5) ralph explain uses the real per-pool numbers when a ledger exists");
{
  const target = makeTarget();
  try {
    const r = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: NOW });
    const out = `${r.stdout}`;
    check(r.status === 0, "explain exits 0");
    check(/pool zai: 5h window 40\.0% \(local: ledger tokens vs budget\) vs cap 70%/.test(out),
      "the 5h cap check uses the ledger-derived 40%, and says where it came from");
    check(/pool zai: weekly window 38\.0% \(local: ledger tokens vs budget\) vs cap 45%/.test(out),
      "the weekly cap check uses the ledger-derived 38%");
    check(!/pool zai: 5h window 0\.0%/.test(out) && !/pool zai:.*assumed, no observation/.test(out),
      "explain no longer assumes 0% for a pool the ledger has records for");
    check(/pool zai 5h window: 8000 token\(s\) over 2 record\(s\), 40\.0% of the 20000-token budget/.test(out),
      "explain prints the normalized per-pool record");
    check(/resets 2026-08-12T09:00:00Z \(weekly_anchor\); near_weekly_reset=no/.test(out),
      "explain prints the weekly reset and its proximity");
    check(/pool openai 5h window: 1234 token\(s\) over 1 record\(s\), no budget configured -> pct unknown/.test(out),
      "a pool without a budget shows raw tokens and an unknown pct");
    check(/^CHOSEN: zlaude$/m.test(out), "under both caps, the cheapest rung still wins");

    // The same numbers over a budget small enough to breach the cap: explain must
    // now skip the rung it would have chosen when it assumed 0%.
    const tight = makeTarget(profile({ fiveHourBudget: 5000 }));  // 8000/5000 = 160%
    try {
      const t = ralph(["explain", "--repo", tight, "--complexity", "small"],
        { RALPH_EFFICIENCY_NOW: NOW });
      const tightOut = `${t.stdout}`;
      check(/pool zai: 5h window 160\.0% .* vs cap 70% — OVER CAP/.test(tightOut),
        "a budget the ledger has blown through reads as OVER CAP");
      check(/^CHOSEN: codex$/m.test(tightOut), "explain skips the over-cap rung");
    } finally { rmSync(tight, { recursive: true, force: true }); }

    // Without budgets there is no denominator, so explain is honest about assuming 0%.
    const bare = makeTarget(profile({ budgets: false }));
    try {
      const b = ralph(["explain", "--repo", bare, "--complexity", "small"],
        { RALPH_EFFICIENCY_NOW: NOW });
      const bareOut = `${b.stdout}`;
      check(/pool zai: 5h window 0\.0% \(assumed, no observation\)/.test(bareOut),
        "with no budget the cap check still says it is assuming 0%");
      check(/pool zai 5h window: 8000 token\(s\) over 2 record\(s\), no budget configured -> pct unknown/.test(bareOut),
        "…while still reporting the raw tokens it did observe");
    } finally { rmSync(bare, { recursive: true, force: true }); }

    // --json carries the normalized records for a later slice to consume.
    const j = ralph(["explain", "--repo", target, "--complexity", "small", "--json"],
      { RALPH_EFFICIENCY_NOW: NOW });
    const data = JSON.parse(`${j.stdout}`);
    const rec = data.usage.state.records.find((x) => x.pool === "zai" && x.window === "weekly");
    check(rec.used_tokens === ZAI_WEEKLY && rec.pct === 38 && rec.budget_tokens === 100000,
      "JSON: usage.state carries the normalized per-pool records");
    check(data.enforced === false, "JSON: still enforced=false — this governs nothing");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 6) A quota observation still wins over the local estimate ─────────────
console.log("6) a ledger quota observation beats the local budget estimate");
{
  const quotaLine = JSON.stringify({
    run_id: "run-B", round: "task-002", timestamp: "2026-08-10T10:30:00Z",
    agents: { builder: { provider: "zlaude" }, reviewer: { provider: "zlaude" } },
    tokens: { input: 0, output: 0, cached: 0, total: 0 },
    quota: { pool: "zai", window_5h_pct: 12, window_weekly_pct: 90 },
  });
  const target = makeTarget(profile(), LEDGER + quotaLine + "\n");
  try {
    const out = `${ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: NOW }).stdout}`;
    check(/pool zai: 5h window 12\.0% vs cap 70%/.test(out),
      "the quota-reported 12% wins over the locally computed pct");
    check(/pool zai: weekly window 90\.0% vs cap 45% — OVER CAP/.test(out),
      "…including when that makes the pool ineligible");
    check(/^CHOSEN: codex$/m.test(out), "the over-quota rung is skipped");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 7) No ledger -> no observations, and it says so ───────────────────────
console.log("7) no ledger -> no fabricated numbers");
{
  const target = makeTarget(profile(), null);
  try {
    const state = usageStateJson(target, { RALPH_EFFICIENCY_NOW: NOW });
    check(state.source === "none" && state.ledger === null, "reports source=none with no ledger");
    check(state.records.every((r) => r.used_tokens === 0 && r.pct === "unknown"),
      "no ledger -> 0 observed tokens and an unknown pct even where a budget exists");
    check(state.notes.some((n) => /no ledger at/.test(n)), "says there is no ledger");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 8) Read-only: nothing in the target is written or created ────────────
console.log("8) the reader is read-only");
{
  const target = makeTarget();
  const snapshot = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath || e.path, e.name))
    .sort()
    .map((f) => `${path.relative(dir, f)}:${readFileSync(f, "utf-8").length}`)
    .join("\n");
  try {
    const before = snapshot(target);
    usageStateJson(target, { RALPH_EFFICIENCY_NOW: NOW });
    usageState(target, [], { RALPH_EFFICIENCY_NOW: NOW });
    ralph(["explain", "--repo", target, "--complexity", "small"], { RALPH_EFFICIENCY_NOW: NOW });
    check(snapshot(target) === before, "ledger + profile are byte-identical and no file was added");
    check(!existsSync(path.join(templateDir, "__pycache__")),
      "no __pycache__ is left in the template dir");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 9) A malformed budget / anchor is REJECTED to inert, never fatal ──────
console.log("9) malformed budgets / anchors are rejected to a safe inert state");
{
  const cases = [
    ["negative budget", { window_5h_pct: 70, window_weekly_pct: 45, window_5h_budget_tokens: -1 }],
    ["non-numeric budget", { window_5h_pct: 70, window_weekly_pct: 45, window_weekly_budget_tokens: "lots" }],
    ["unparseable anchor", { window_5h_pct: 70, window_weekly_pct: 45, weekly_reset_anchor: "next tuesday" }],
  ];
  for (const [label, zaiCap] of cases) {
    const prof = profile();
    prof.rungs[0].caps.zai = zaiCap;
    const target = makeTarget(prof);
    try {
      const r = ralph(["explain", "--repo", target, "--complexity", "small"],
        { RALPH_EFFICIENCY_NOW: NOW });
      check(r.status === 0, `${label}: exits 0 (never crashes the harness)`);
      check(/REJECTED efficiency profile/.test(`${r.stderr}`), `${label}: loud REJECTED warning`);
      check(/efficiency mode: OFF \(inert\)/.test(`${r.stdout}`), `${label}: falls back to inert`);
    } finally { rmSync(target, { recursive: true, force: true }); }
  }

  // A well-formed budget alongside every cap shape is accepted.
  const prof = profile();
  prof.rungs[1].caps.openai = { source: "provider", window_weekly_budget_tokens: 500000 };
  const target = makeTarget(prof);
  try {
    const r = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: NOW });
    check(!/REJECTED/.test(`${r.stderr}`), "a budget on a {source: provider} cap is valid");
    check(/pool openai weekly window: 1234 token\(s\) over 1 record\(s\), 0\.2% of the 500000-token budget/
      .test(`${r.stdout}`), "…and its pct is computed from the ledger");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 10) The bash entry point is usable both ways ──────────────────────────
console.log("10) usage-state.sh works sourced and executed");
{
  const target = makeTarget();
  try {
    const sourced = spawnSync("bash", ["-c",
      `source "${helperSh}"; ralph_usage_state_json "${target}"`],
      { encoding: "utf-8", env: cleanEnv({ RALPH_EFFICIENCY_NOW: NOW }) });
    check(sourced.status === 0, "sourced: ralph_usage_state_json exits 0");
    const state = JSON.parse(`${sourced.stdout}`);
    check(recordFor(state, "zai", "5h").used_tokens === ZAI_5H,
      "sourced: returns the same per-pool numbers");

    const report = spawnSync("bash", ["-c",
      `source "${helperSh}"; ralph_usage_state_report "${target}"`],
      { encoding: "utf-8", env: cleanEnv({ RALPH_EFFICIENCY_NOW: NOW }) });
    check(report.status === 0 && /pool zai \[weekly\]: used 38000 token\(s\)/.test(`${report.stdout}`),
      "sourced: ralph_usage_state_report prints the human summary");

    const help = spawnSync("bash", [helperSh, "--help"], { encoding: "utf-8", env: cleanEnv() });
    check(help.status === 0 && /--repo DIR/.test(`${help.stdout}`), "executed: --help documents the CLI");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

console.log(`\nusage-state: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
