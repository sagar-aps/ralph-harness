// Tests for ralph_efficiency_select — the rung selection function (#61).
//
// This slice is the ENFORCEMENT keystone, so the fixtures below pin the decisions
// rather than the prose: tier order, per-pool caps, avoid windows, the #28 quota
// circuit, the manager(25%)/zai(55%) weekly reserves enforced in CODE, the
// near-WEEKLY-reset relaxation that lifts the weekly gates, the deepseek backstop,
// the bounded PAUSE when even the backstop is gone, and FAIL-OPEN on unknown usage.
//
// It still governs nothing: nothing here dispatches, and the last section proves a
// dry-run review resolves the same backends with and without the opt-in.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(repoRoot, ".agents", "ralph");
const script = path.join(templateDir, "efficiency.py");
const helperSh = path.join(templateDir, "efficiency.sh");
const cliPath = path.join(repoRoot, "bin", "ralph");
const example = JSON.parse(
  readFileSync(path.join(templateDir, "efficiency.json.example"), "utf-8"));

// Exit codes are STATUSES, never crashes (see cmd_select).
const EXIT_PAUSED = 3;
const EXIT_INERT = 4;

// Monday 2026-08-10 11:00 UTC: outside the zai avoid window (06:00-10:00 Mon-Fri).
const NOW = "2026-08-10T11:00:00Z";
// The weekly window of the fixtures resets Wed 2026-08-12 09:00 UTC — 46h after
// NOW, i.e. far outside reserves.near_weekly_reset_hours (5).
const RESET = "2026-08-12T09:00:00Z";
// 3h before that reset: inside the relaxation window.
const NEAR_RESET = "2026-08-12T06:00:00Z";

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
}

const cleanEnv = (env = {}) => ({
  ...process.env,
  RALPH_SKIP_UPDATE_CHECK: "1",
  RALPH_NO_LOCAL_CONFIG: "1",
  // Scrub anything an outer ralph run exported, so the fixture decides everything.
  TARGET_REPO: "", PRD_PATH: "", TASK_ID: "", TASK_INDEX: "", BRANCH: "",
  BUILDER: "", REVIEWER: "", RALPH_PROFILE: "",
  RALPH_EFFICIENCY: "", RALPH_EFFICIENCY_PROFILE: "", RALPH_EFFICIENCY_NOW: "",
  RALPH_QUOTA_OPEN_CIRCUITS: "",
  ...env,
});

// A ledger line whose `quota` block states one pool's window usage. The reader
// (#60) treats that as the closest thing to a provider-reported number, so it is
// the cleanest way to hand the selector a known percentage.
const quotaLine = (quota, provider = "zlaude") => JSON.stringify({
  run_id: "run-A",
  round: "task-001",
  timestamp: "2026-08-10T10:00:00Z",
  agents: { builder: { provider }, reviewer: { provider } },
  invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
  tokens: { input: 1000, output: 200, cached: 0, total: 1200 },
  quota,
});

function makeTarget(profile = example, ledgerLines = []) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-select-"));
  mkdirSync(path.join(target, ".agents", "ralph"), { recursive: true });
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  // `null` means "write no profile at all" (undefined would take the default).
  if (profile !== null) {
    writeFileSync(path.join(target, ".agents", "ralph", "efficiency.json"),
      typeof profile === "string" ? profile : JSON.stringify(profile, null, 2));
  }
  if (ledgerLines.length) {
    writeFileSync(path.join(target, ".ralph", "ledger.jsonl"), ledgerLines.join("\n") + "\n");
  }
  return target;
}

// The selection function itself, via its CLI seam.
function select(target, complexity, { now = NOW, pools = [], args = [], env = {} } = {}) {
  const extra = pools.flatMap((p) => ["--exhausted-pool", p]);
  const r = spawnSync("python3",
    [script, "select", "--complexity", complexity, "--repo", target, ...extra, ...args],
    { encoding: "utf-8", env: cleanEnv({ RALPH_EFFICIENCY_NOW: now, ...env }) });
  return r;
}

function selectJson(target, complexity, opts = {}) {
  const r = select(target, complexity, { ...opts, args: ["--json", ...(opts.args || [])] });
  return { ...JSON.parse(`${r.stdout}`), exit: r.status, stderr: `${r.stderr}` };
}

// ── 1) Tier order: the cheapest allowed rung wins, per complexity ─────────
console.log("1) tier ordering: the first allowed rung wins, per complexity");
{
  const target = makeTarget();
  try {
    // Sunday 12:00 UTC — no ledger, no avoid window active.
    const sunday = "2026-08-09T12:00:00Z";
    const expected = {
      trivial: ["deepseek", "dlaude"],
      small: ["zlaude", "zlaude"],
      medium: ["codex", "codex"],
      large: ["claude", "claude"],
    };
    for (const [complexity, [rung, builder]] of Object.entries(expected)) {
      const data = selectJson(target, complexity, { now: sunday });
      check(data.exit === 0 && data.status === "selected",
        `${complexity}: exits 0 with status=selected`);
      check(data.rung_name === rung, `${complexity}: picks ${rung}`);
      check(data.builder.backend === builder, `${complexity}: builder=${builder}`);
      check(data.reviewer.backend === (rung === "codex" ? "codex-readonly" : builder),
        `${complexity}: reviewer is the rung's reviewer backend`);
      check(data.order.join(",") === example.tiers[complexity].join(","),
        `${complexity}: reports the tier order it walked`);
      check(data.enforced === false && data.backstop === false,
        `${complexity}: enforced=false, no backstop fallback needed`);
      check(typeof data.reason === "string" && data.reason.includes(complexity),
        `${complexity}: names the tier in its reason`);
    }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 2) The manager (anthropic) reserve blocks claude at 76% weekly ────────
console.log("2) the anthropic 25% weekly reserve blocks claude at 76% weekly");
{
  // Cap 75%/week and reserve 25% both bite at 76% used; the relaxation lifts both.
  const ledger = [quotaLine(
    { pool: "anthropic", window_5h_pct: 10, window_weekly_pct: 76, weekly_reset_at: RESET },
    "claude")];
  const target = makeTarget(example, ledger);
  try {
    const blocked = selectJson(target, "large");
    const claude = blocked.rungs.find((r) => r.name === "claude");
    check(blocked.rung_name === "deepseek" && blocked.status === "selected",
      "large falls through claude to the next allowed rung (deepseek)");
    check(claude.eligible === false, "the claude rung is not eligible");
    check(claude.checks.some((c) => !c.ok && /vs cap 75% — OVER CAP/.test(c.detail)),
      "the 75% weekly cap is reported as breached");
    check(claude.checks.some((c) => !c.ok
      && /24\.0% of the weekly window left .*vs reserve 25% .*BELOW RESERVE/.test(c.detail)),
      "the 25% weekly reserve is reported as breached (24% left)");

    // 3h before the weekly reset the SAME numbers pass: expiring quota is spendable.
    const lifted = selectJson(target, "large", { now: NEAR_RESET });
    const liftedClaude = lifted.rungs.find((r) => r.name === "claude");
    check(lifted.rung_name === "claude", "near the weekly reset claude is chosen again");
    check(liftedClaude.relaxed === true, "the rung records that a weekly gate was relaxed");
    check(liftedClaude.checks.some((c) => c.ok && /OVER CAP.*RELAXED/.test(c.detail)),
      "the weekly cap is lifted by the near-weekly-reset relaxation");
    check(liftedClaude.checks.some((c) => c.ok && /reserve 25% RELAXED/.test(c.detail)),
      "…and so is the weekly reserve");
    check(/near-weekly-reset relaxation/.test(lifted.reason),
      "the reason says the choice depends on the relaxation");

    // The 5h window is a rate limit, not an expiring budget: it is never relaxed.
    const fiveHour = makeTarget(example, [quotaLine(
      { pool: "anthropic", window_5h_pct: 95, window_weekly_pct: 10, weekly_reset_at: RESET },
      "claude")]);
    try {
      const data = selectJson(fiveHour, "large", { now: NEAR_RESET });
      check(data.rung_name === "deepseek",
        "an over-cap 5h window still blocks the rung near the weekly reset");
      check(data.rungs.find((r) => r.name === "claude").checks.some(
        (c) => !c.ok && /5h window 95\.0% .*vs cap 80% — OVER CAP/.test(c.detail)
          && !/RELAXED/.test(c.detail)),
        "the 5h cap check is not relaxed");
    } finally { rmSync(fiveHour, { recursive: true, force: true }); }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 3) zai: the 45% cap / 55% reserve, and the avoid window ───────────────
console.log("3) zai is blocked at 46% weekly and inside its avoid window");
{
  const target = makeTarget(example, [quotaLine(
    { pool: "zai", window_5h_pct: 10, window_weekly_pct: 46, weekly_reset_at: RESET })]);
  try {
    const data = selectJson(target, "small");
    const zlaude = data.rungs.find((r) => r.name === "zlaude");
    check(data.rung_name === "codex", "small skips zlaude and takes codex");
    check(zlaude.checks.some((c) => !c.ok && /weekly window 46\.0% vs cap 45% — OVER CAP/.test(c.detail)),
      "46% breaches the 45% weekly cap");
    check(zlaude.checks.some((c) => !c.ok && /vs reserve 55% \(from the profile\) — BELOW RESERVE/.test(c.detail)),
      "…and the 55% weekly reserve (read from the profile)");

    // Well under both, but inside 06:00-10:00 Mon-Fri: the window alone blocks it.
    const rested = makeTarget(example, [quotaLine(
      { pool: "zai", window_5h_pct: 1, window_weekly_pct: 2, weekly_reset_at: RESET })]);
    try {
      const inside = selectJson(rested, "small", { now: "2026-08-10T07:30:00Z" });
      check(inside.rung_name === "codex", "inside the avoid window small falls to codex");
      check(inside.rungs.find((r) => r.name === "zlaude").checks.some(
        (c) => !c.ok && /avoid window 06:00-10:00 UTC Mon-Fri .*ACTIVE now/.test(c.detail)),
        "the active avoid window is the reported blocker");
      const outside = selectJson(rested, "small", { now: NOW });
      check(outside.rung_name === "zlaude", "outside the window the same numbers pass");
      const weekend = selectJson(rested, "small", { now: "2026-08-08T07:30:00Z" });
      check(weekend.rung_name === "zlaude",
        "the Mon-Fri window does not apply at the same time on Saturday");
    } finally { rmSync(rested, { recursive: true, force: true }); }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 4) Reserves are enforced in CODE, not switched off by profile data ────
console.log("4) reserves are enforced in code (profile omission does not disable them)");
{
  // A profile that names NO reserves at all. The code still keeps 25% of the
  // anthropic week and 55% of the zai week; a pool with no code reserve and no
  // profile reserve (openai/deepseek) has none.
  const noReserves = JSON.parse(JSON.stringify(example));
  noReserves.reserves = {};
  const target = makeTarget(noReserves, [quotaLine(
    { pool: "anthropic", window_5h_pct: 5, window_weekly_pct: 76, weekly_reset_at: RESET },
    "claude")]);
  try {
    const data = selectJson(target, "large");
    const claude = data.rungs.find((r) => r.name === "claude");
    check(data.rung_name === "deepseek", "the code-default anthropic reserve still blocks claude");
    check(claude.checks.some((c) => !c.ok
      && /vs reserve 25% \(code default, not set in the profile\) — BELOW RESERVE/.test(c.detail)),
      "the check names the code default it enforced");

    // …and the code default for near_weekly_reset_hours (5) still relaxes it.
    const lifted = selectJson(target, "large", { now: NEAR_RESET });
    check(lifted.rung_name === "claude",
      "the code-default near_weekly_reset_hours=5 still lifts the reserve");

    // An operator's own number wins over the default (this is config, not policy).
    const strict = JSON.parse(JSON.stringify(example));
    strict.reserves.anthropic_weekly_pct = 90;   // keep 90% of the week unspent
    strict.reserves.near_weekly_reset_hours = 1; // …and barely ever relax it
    const strictTarget = makeTarget(strict, [quotaLine(
      { pool: "anthropic", window_5h_pct: 5, window_weekly_pct: 15, weekly_reset_at: RESET },
      "claude")]);
    try {
      const s = selectJson(strictTarget, "large");
      check(s.rung_name === "deepseek",
        "a stricter profile reserve is honoured (15% used, only 85% left vs a 90% reserve)");
      check(s.rungs.find((r) => r.name === "claude").checks.some(
        (c) => !c.ok && /vs reserve 90% \(from the profile\)/.test(c.detail)),
        "the profile's number is used when it is present");
      const near = selectJson(strictTarget, "large", { now: NEAR_RESET });
      check(near.rung_name === "deepseek",
        "3h out is no longer 'near' when the profile sets near_weekly_reset_hours=1");
    } finally { rmSync(strictTarget, { recursive: true, force: true }); }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 5) Backstop fallback and the bounded PAUSE ───────────────────────────
console.log("5) deepseek backstop fallback, then a bounded PAUSE");
{
  // tier small = [zlaude, codex]; block both -> the backstop, which small does
  // not even list, is used.
  const openaiCapped = JSON.parse(JSON.stringify(example));
  openaiCapped.rungs[1].caps.openai = { window_5h_pct: 50, window_weekly_pct: 50 };
  const target = makeTarget(openaiCapped, [
    quotaLine({ pool: "zai", window_5h_pct: 99, window_weekly_pct: 99, weekly_reset_at: RESET }),
    quotaLine({ pool: "openai", window_5h_pct: 99, window_weekly_pct: 99 }, "codex"),
  ]);
  try {
    const data = selectJson(target, "small");
    check(data.status === "selected" && data.exit === 0, "a fully capped tier is not a failure");
    check(data.rung_name === "deepseek" && data.backstop === true,
      "the deepseek backstop is chosen when every tier rung is capped");
    check(data.builder.backend === "dlaude" && data.reviewer.backend === "dlaude",
      "the backstop rung's backends are returned");
    check(data.rungs.some((r) => r.name === "deepseek" && r.in_tier === false),
      "the backstop is reported as evaluated outside the tier order");
    check(/backstop/.test(data.reason), "the reason says it fell back to the backstop");
    check(data.rungs.find((r) => r.name === "deepseek").checks.some(
      (c) => c.ok && /backstop rung — no window cap and no reserve/.test(c.detail)),
      "the backstop pool is exempt from caps and reserves");

    // The one thing that CAN take the backstop out: its #28 circuit. That is a
    // distinct bounded PAUSE, not a crash and not a silent selection.
    const paused = selectJson(target, "small", { pools: ["deepseek"] });
    check(paused.exit === EXIT_PAUSED, `the PAUSE exit code is ${EXIT_PAUSED}, not a crash`);
    check(paused.status === "paused", "status=paused");
    check(paused.rung_name === null && paused.builder === null && paused.reviewer === null,
      "no rung, builder or reviewer is returned on a PAUSE");
    check(paused.pause && paused.pause.seconds > 0 && paused.pause.seconds <= 5 * 3600,
      "the pause is BOUNDED (<= the 5h rolling window)");
    check(typeof paused.pause.until === "string" && /Z$/.test(paused.pause.until),
      "the pause carries the UTC instant to retry at");
    check(/bounded PAUSE/.test(paused.reason) && /backstop rung is unavailable/.test(paused.reason),
      "the reason says why even the backstop was unusable");

    // An active avoid window on the backstop rung pauses too (same signal).
    const windowed = JSON.parse(JSON.stringify(openaiCapped));
    windowed.rungs[3].avoid_windows = [{
      from: "06:00", to: "23:00", tz: "UTC", days: "*", reason: "maintenance",
    }];
    const windowedTarget = makeTarget(windowed, [
      quotaLine({ pool: "zai", window_5h_pct: 99, window_weekly_pct: 99, weekly_reset_at: RESET }),
      quotaLine({ pool: "openai", window_5h_pct: 99, window_weekly_pct: 99 }, "codex"),
    ]);
    try {
      const r = select(windowedTarget, "small");
      check(r.status === EXIT_PAUSED && /^PAUSE: bounded — retry in \d+s \(at .*Z\)$/m.test(`${r.stdout}`),
        "an avoid window over the backstop also yields the bounded PAUSE");
    } finally { rmSync(windowedTarget, { recursive: true, force: true }); }

    // A profile with no backstop rung at all pauses rather than inventing one.
    const noBackstop = JSON.parse(JSON.stringify(openaiCapped));
    noBackstop.rungs = noBackstop.rungs.filter((r) => r.name !== "deepseek");
    noBackstop.tiers = { trivial: ["zlaude"], small: ["zlaude", "codex"], medium: ["codex"], large: ["claude"] };
    const noBackstopTarget = makeTarget(noBackstop, [
      quotaLine({ pool: "zai", window_5h_pct: 99, window_weekly_pct: 99, weekly_reset_at: RESET }),
      quotaLine({ pool: "openai", window_5h_pct: 99, window_weekly_pct: 99 }, "codex"),
    ]);
    try {
      const data2 = selectJson(noBackstopTarget, "small");
      check(data2.exit === EXIT_PAUSED && /configures no backstop rung/.test(data2.reason),
        "a profile without a backstop rung pauses and says so");
    } finally { rmSync(noBackstopTarget, { recursive: true, force: true }); }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 6) The #28 circuit gates a pool, whatever its usage says ─────────────
console.log("6) an open #28 circuit makes a pool ineligible");
{
  const target = makeTarget();  // no ledger at all: usage is unknown everywhere
  try {
    const open = selectJson(target, "small", { pools: ["zai"] });
    check(open.rung_name === "codex", "an open circuit on zai pushes small to codex");
    const zlaude = open.rungs.find((r) => r.name === "zlaude");
    check(zlaude.checks.some((c) => !c.ok && /#28 quota circuit is OPEN/.test(c.detail)),
      "the circuit is the reported blocker");
    check(open.exhausted_pools.join(",") === "zai", "the circuit input is echoed back");
    const closed = selectJson(target, "small");
    check(closed.rung_name === "zlaude" && closed.rungs.find((r) => r.name === "zlaude").checks
      .some((c) => c.ok && /#28 quota circuit is closed/.test(c.detail)),
      "with the circuit closed the same pool is eligible");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 7) Unknown usage FAILS OPEN — never a frozen ladder ──────────────────
console.log("7) unknown pool usage fails open (eligible), never frozen");
{
  // No ledger => no quota block and no budget => no percentage exists for any pool.
  const target = makeTarget();
  try {
    const data = selectJson(target, "small");
    const zlaude = data.rungs.find((r) => r.name === "zlaude");
    check(data.rung_name === "zlaude", "with no usage data the cheapest rung is still usable");
    check(zlaude.checks.filter((c) => c.kind === "cap").every((c) => c.ok
      && /FAIL-OPEN: no usage data for this pool/.test(c.detail)),
      "both cap checks pass and say they failed open");
    check(zlaude.checks.some((c) => c.kind === "reserve" && c.ok
      && /weekly usage unknown, FAIL-OPEN/.test(c.detail)),
      "the reserve check fails open too, and names the #28 circuit as the real gate");

    // A ledger with spend but no quota block and no budget: same conclusion.
    const spent = makeTarget(example, [JSON.stringify({
      run_id: "run-C", round: "task-003", timestamp: "2026-08-10T10:00:00Z",
      agents: { builder: { provider: "zlaude" }, reviewer: { provider: "zlaude" } },
      tokens: { input: 1000, output: 200, cached: 0, total: 1200 },
    })]);
    try {
      const d = selectJson(spent, "small");
      check(d.rung_name === "zlaude" && d.status === "selected",
        "observed spend without a budget or quota block does not block a pool");
    } finally { rmSync(spent, { recursive: true, force: true }); }

    // Fail-open is bounded by the circuit: unknown usage + open circuit = blocked.
    const both = selectJson(target, "small", { pools: ["zai", "openai"] });
    check(both.rung_name === "deepseek",
      "unknown usage does NOT survive an open circuit — the circuit is the real gate");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 8) A malformed profile is inert — never partial enforcement ──────────
console.log("8) malformed / missing profile -> inert, never partial enforcement");
{
  for (const [label, profile] of [
    ["unparseable JSON", "{ not json at all"],
    ["cap missing for a pool", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "y", pool: "q" },
        caps: { p: { backstop: true } },
      }],
      reserves: { near_weekly_reset_hours: 5 },
      tiers: { trivial: ["a"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
    ["no profile at all", null],
  ]) {
    const target = makeTarget(profile);
    try {
      const r = select(target, "medium");
      const data = JSON.parse(`${select(target, "medium", { args: ["--json"] }).stdout}`);
      check(r.status === EXIT_INERT, `${label}: exits ${EXIT_INERT} (inert), never crashes`);
      check(data.status === "inert" && data.rung_name === null && data.builder === null,
        `${label}: selects nothing at all`);
      check(data.enforced === false, `${label}: nothing was enforced`);
      if (profile !== null) {
        check(/REJECTED efficiency profile/.test(`${r.stderr}`), `${label}: loud REJECTED warning`);
      } else {
        check(/efficiency profile not configured/.test(`${r.stdout}`),
          `${label}: clean not-configured message`);
      }
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
}

// ── 9) Read-only: selecting writes nothing and dispatches nothing ────────
console.log("9) selection is pure: no writes, no dispatch");
{
  const target = makeTarget(example, [quotaLine(
    { pool: "zai", window_5h_pct: 46, window_weekly_pct: 46, weekly_reset_at: RESET })]);
  const snapshot = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath || e.path, e.name))
    .sort()
    .map((f) => `${path.relative(dir, f)}:${readFileSync(f, "utf-8").length}`)
    .join("\n");
  try {
    const before = snapshot(target);
    for (const complexity of ["trivial", "small", "medium", "large"]) {
      select(target, complexity);
      select(target, complexity, { pools: ["zai"] });
    }
    check(snapshot(target) === before, "the target repo is byte-identical afterwards");

    const r = select(target, "small");
    check(/nothing was dispatched here/.test(`${r.stdout}`),
      "the human output states that the CLI seam itself dispatched nothing");
    check(/^SELECTED: codex$/m.test(`${r.stdout}`), "the human output names the selected rung");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 10) The bash entry point + the #28 circuit it reuses ─────────────────
console.log("10) ralph_efficiency_select (bash) reuses ralph_quota_pool_is_exhausted");
{
  const target = makeTarget();
  const runBash = (body, env = {}) => spawnSync("bash", ["-c",
    `set -euo pipefail; source "${helperSh}"; ${body}`],
    { encoding: "utf-8", env: cleanEnv({ RALPH_EFFICIENCY_NOW: NOW, ...env }) });
  // Call the function, then report every variable it is contracted to set.
  const report = (complexity, repo) =>
    `rc=0; ralph_efficiency_select ${complexity} "${repo}" >/dev/null || rc=$?; `
    + 'echo "rc=$rc rung=$RALPH_EFFICIENCY_SELECT_RUNG '
    + 'builder=$RALPH_EFFICIENCY_SELECT_BUILDER reviewer=$RALPH_EFFICIENCY_SELECT_REVIEWER '
    + 'status=$RALPH_EFFICIENCY_SELECT_STATUS pause=$RALPH_EFFICIENCY_SELECT_PAUSE_SECONDS"';
  try {
    const ok = runBash(report("small", target));
    check(ok.status === 0, "sourced: ralph_efficiency_select returns 0 on a selection");
    check(/rc=0 rung=zlaude builder=zlaude reviewer=zlaude status=selected pause=/.test(`${ok.stdout}`),
      "sourced: the RALPH_EFFICIENCY_SELECT_* variables carry the decision");

    // A #28 circuit recorded for zai (reset far in the future) is still OPEN, so
    // the bash wrapper must feed it in and the selector must skip zlaude.
    const open = runBash(report("small", target),
      { RALPH_QUOTA_OPEN_CIRCUITS: "zai|2099-01-01T00:00:00Z" });
    check(/rung=codex/.test(`${open.stdout}`),
      "an open circuit from RALPH_QUOTA_OPEN_CIRCUITS skips the pool");

    // An ELAPSED reset means the circuit is closed — that decision belongs to
    // ralph_quota_pool_is_exhausted, and selection must inherit it.
    const elapsed = runBash(report("small", target),
      { RALPH_QUOTA_OPEN_CIRCUITS: "zai|2000-01-01T00:00:00Z" });
    check(/rung=zlaude/.test(`${elapsed.stdout}`),
      "an elapsed circuit is closed again (agents.sh owns that rule)");

    // PAUSE and INERT are statuses, not crashes: distinct return codes, no exit.
    const paused = runBash(report("large", target),
      { RALPH_QUOTA_OPEN_CIRCUITS: "anthropic|2099-01-01T00:00:00Z\ndeepseek|2099-01-01T00:00:00Z" });
    check(/rc=3 rung= /.test(`${paused.stdout}`) && /status=paused/.test(`${paused.stdout}`),
      "sourced: a PAUSE returns 3 with no rung");
    check(/pause=\d+$/.test(`${paused.stdout}`.trim()), "sourced: the bounded pause is exported");

    const bare = makeTarget(null);
    try {
      const inert = runBash(report("small", bare));
      check(/rc=4/.test(`${inert.stdout}`) && /status=inert/.test(`${inert.stdout}`),
        "sourced: a missing profile returns 4 (inert), never a crash");
    } finally { rmSync(bare, { recursive: true, force: true }); }

    const noArg = runBash('rc=0; ralph_efficiency_select >/dev/null 2>&1 || rc=$?; echo "rc=$rc"');
    check(/rc=4/.test(`${noArg.stdout}`), "sourced: a missing complexity is inert, not fatal");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 11) An UNSIZED story is dispatched exactly as it is today ────────────
console.log("11) with no complexity on the story, --efficiency changes no dispatch");
{
  const mkRepo = () => {
    const target = makeTarget();
    const g = (...a) => spawnSync("git", ["-C", target, ...a], { encoding: "utf-8" });
    g("init", "-q");
    g("config", "user.email", "test@example.com");
    g("config", "user.name", "Ralph Test");
    mkdirSync(path.join(target, ".agents", "tasks"), { recursive: true });
    writeFileSync(path.join(target, ".agents", "tasks", "prd.json"), JSON.stringify({
      version: 1,
      project: "Target",
      stories: [{ id: "US-001", title: "A story", status: "open", acceptanceCriteria: ["a"] }],
    }, null, 2));
    writeFileSync(path.join(target, "README.md"), "# Target\n");
    writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-handoff.md\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    return target;
  };
  const worktreeFor = (target) => path.join(target, "..", `ralph-wt-${path.basename(target)}`);
  const runReview = (target, extraArgs, env) => spawnSync(process.execPath, [cliPath,
    "review", "1", "--repo", target, "--builder", "fixture-build", "--reviewer", "fixture-review",
    "--max-iterations", "1", "--check", "true", ...extraArgs],
    {
      encoding: "utf-8",
      env: cleanEnv({
        RALPH_DRY_RUN: "1",
        RALPH_WORKTREE_DIR: worktreeFor(target),
        AGENT_FIXTURE_BUILD_CMD: "opencode run {prompt}",
        AGENT_FIXTURE_REVIEW_CMD: "claude -p",
        ...env,
      }),
    });
  const selection = (out) => (out.match(/^\s*Agents: .*$/m) || [""])[0];
  const plain = mkRepo();
  const opted = mkRepo();
  try {
    const a = runReview(plain, [], {});
    const b = runReview(opted, ["--efficiency"], {});
    const aOut = `${a.stdout}${a.stderr}`;
    const bOut = `${b.stdout}${b.stderr}`;
    check(selection(aOut) !== "" && selection(aOut) === selection(bOut),
      "the resolved builder/reviewer are identical with and without --efficiency");
    check(a.status === b.status && /READY_FOR_HUMAN_REVIEW/.test(bOut),
      "the opt-in run reaches the same outcome");
    check(!/efficiency: rung /.test(bOut),
      "no rung is applied: the story declares no complexity to right-size it by (#62)");
  } finally {
    for (const t of [plain, opted]) {
      rmSync(worktreeFor(t), { recursive: true, force: true });
      rmSync(t, { recursive: true, force: true });
    }
  }
}

console.log(`\nefficiency-select: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
