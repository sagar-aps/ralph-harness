// Tests for the efficiency profile parser/validator and `ralph explain` (#59).
//
// The whole point of this slice is that efficiency mode is SAFE and INERT: a valid
// profile is parsed and explained, a malformed one is rejected to off WITHOUT
// crashing, a missing one says so cleanly, and none of it changes dispatch.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");
const examplePath = path.join(repoRoot, ".agents", "ralph", "efficiency.json.example");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
}

function makeTarget(profile) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-eff-"));
  mkdirSync(path.join(target, ".agents", "ralph"), { recursive: true });
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  if (profile !== undefined) {
    writeFileSync(
      path.join(target, ".agents", "ralph", "efficiency.json"),
      typeof profile === "string" ? profile : JSON.stringify(profile, null, 2),
    );
  }
  return target;
}

function ralph(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      RALPH_SKIP_UPDATE_CHECK: "1",
      RALPH_NO_LOCAL_CONFIG: "1",
      // Scrub anything an outer ralph run may have exported into this process, so
      // the fixtures below decide the target, the story and the opt-in state.
      TARGET_REPO: "",
      PRD_PATH: "",
      TASK_ID: "",
      TASK_INDEX: "",
      BRANCH: "",
      BUILDER: "",
      REVIEWER: "",
      RALPH_PROFILE: "",
      RALPH_EFFICIENCY: "",
      RALPH_EFFICIENCY_PROFILE: "",
      RALPH_EFFICIENCY_NOW: "",
      // #63: the reserves follow the control-plane roles, so the driver/manager
      // knobs decide which pool carries them. Pin them off unless a case sets one.
      RALPH_CRON_DRIVER: "",
      RALPH_CRON_DRIVER_DEFAULT: "",
      RALPH_CRON_DRIVER_PROVIDER: "",
      RALPH_CRON_DRIVER_MODEL: "",
      RALPH_CRON_DRIVER_EFFORT: "",
      RALPH_MANAGER_POOL: "",
      // The shipped policy's operator wrappers are resolvable in production via
      // config.local.sh; keep the general fixtures hermetic and explicitly seed them.
      AGENT_ZLAUDE_CMD: "zlaude -p",
      AGENT_DLAUDE_CMD: "dlaude -p",
      ...env,
    },
  });
}

const example = JSON.parse(readFileSync(examplePath, "utf-8"));

// ── 1) The shipped example encodes the finalized policy exactly ───────────
console.log("1) efficiency.json.example encodes the finalized policy");
{
  const byName = Object.fromEntries(example.rungs.map((r) => [r.name, r]));
  check(
    example.rungs.map((r) => r.name).join(",") === "zlaude,codex,claude,deepseek",
    "ladder order: zlaude -> codex -> claude -> deepseek",
  );
  check(byName.zlaude.builder.pool === "zai" && byName.zlaude.reviewer.pool === "zai",
    "zlaude draws on the zai pool");
  check(byName.codex.builder.pool === "openai", "codex draws on the openai pool");
  check(byName.claude.builder.pool === "anthropic", "claude draws on the anthropic pool");

  check(byName.zlaude.caps.zai.window_5h_pct === 70 && byName.zlaude.caps.zai.window_weekly_pct === 45,
    "zai caps: 70% / 5h, 45% / week");
  const win = byName.zlaude.avoid_windows[0];
  check(
    byName.zlaude.avoid_windows.length === 1 && win.from === "06:00" && win.to === "10:00"
      && win.tz === "UTC" && win.days === "Mon-Fri" && win.reason === "3x quota burn (Z.AI peak)",
    "zai avoid window: 06:00-10:00 UTC Mon-Fri (3x quota burn (Z.AI peak))",
  );
  check(byName.codex.caps.openai.source === "provider", "codex cap: {source: provider}");
  check(byName.claude.caps.anthropic.window_5h_pct === 80
    && byName.claude.caps.anthropic.window_weekly_pct === 75, "anthropic caps: 80% / 5h, 75% / week");
  check(byName.deepseek.caps.deepseek.backstop === true, "deepseek cap: {backstop: true}");

  // #63: reserves are keyed by the control-plane ROLE, never by pool.
  check(example.reserves.manager_pct === 25
    && example.reserves.orchestrator_pct === 50
    && example.reserves.near_weekly_reset_hours === 5,
    "reserves: manager 25%, orchestrator 50%, near_weekly_reset 5h");
  check(Object.keys(example.reserves).every((k) => !k.endsWith("_weekly_pct")),
    "no pool-keyed reserve numbers remain in the example");
  check(example.rungs.every((r) => Object.values(r.caps).every((cap) => "backstop" in cap
    || "source" in cap || (typeof cap.window_5h_pct === "number"
      && typeof cap.window_weekly_pct === "number"))),
    "the per-rung window caps are kept as they are");

  check(example.tiers.trivial.join(",") === "deepseek,zlaude", "tier trivial = deepseek, zlaude");
  check(example.tiers.small.join(",") === "zlaude,codex", "tier small = zlaude, codex");
  check(example.tiers.medium.join(",") === "codex,claude,deepseek", "tier medium = codex, claude, deepseek");
  check(example.tiers.large.join(",") === "claude,deepseek", "tier large = claude, deepseek");
}

// ── 2) The real efficiency.json is gitignored; the .example is tracked ─────
console.log("2) the real profile is gitignored, only the .example ships");
{
  const ignored = spawnSync("git", ["-C", repoRoot, "check-ignore", ".agents/ralph/efficiency.json"],
    { encoding: "utf-8" });
  check(ignored.status === 0, ".agents/ralph/efficiency.json is gitignored");
  const tracked = spawnSync("git", ["-C", repoRoot, "check-ignore", ".agents/ralph/efficiency.json.example"],
    { encoding: "utf-8" });
  check(tracked.status !== 0, ".agents/ralph/efficiency.json.example is NOT ignored (it ships)");
}

// ── 3) A valid profile: explain picks sensibly per complexity ─────────────
console.log("3) valid profile -> explain picks sensibly per complexity");
{
  const target = makeTarget(example);
  try {
    // A Sunday at 12:00 UTC: outside the Mon-Fri avoid window, no ledger.
    const clock = { RALPH_EFFICIENCY_NOW: "2026-08-09T12:00:00Z" };
    const expected = {
      trivial: "deepseek",
      small: "zlaude",
      medium: "codex",
      large: "claude",
    };
    for (const [complexity, rung] of Object.entries(expected)) {
      const r = ralph(["explain", "--repo", target, "--complexity", complexity], clock);
      const out = `${r.stdout}`;
      check(r.status === 0, `explain --complexity ${complexity} exits 0`);
      check(new RegExp(`^CHOSEN: ${rung}$`, "m").test(out),
        `${complexity} chooses the cheapest allowed rung (${rung})`);
      check(/^WHY: /m.test(out), `${complexity} prints WHY`);
      check(out.includes(`tier ${complexity} allows (in order):`),
        `${complexity} lists the tier's rungs in order`);
      check(/explain is read-only — nothing was dispatched here/.test(out),
        `${complexity} states that explain itself dispatched nothing`);
    }

    // No ledger -> says it is assuming 0%.
    const r = ralph(["explain", "--repo", target, "--complexity", "small"], clock);
    check(/assuming 0% used for every pool/.test(`${r.stdout}`),
      "with no ledger, explain assumes 0% used and says so");

    // Read-only: the target is untouched.
    const before = readFileSync(path.join(target, ".agents", "ralph", "efficiency.json"), "utf-8");
    ralph(["explain", "--repo", target, "--complexity", "large"], clock);
    const after = readFileSync(path.join(target, ".agents", "ralph", "efficiency.json"), "utf-8");
    check(before === after, "explain is read-only (profile unchanged)");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 4) Avoid windows are evaluated against the current UTC time ───────────
console.log("4) avoid_windows are evaluated against the current UTC time");
{
  const target = makeTarget(example);
  try {
    // Monday 07:30 UTC is INSIDE 06:00-10:00 Mon-Fri -> zlaude is skipped.
    const inside = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: "2026-08-10T07:30:00Z" });
    const insideOut = `${inside.stdout}`;
    check(/ACTIVE now/.test(insideOut), "reports the avoid window as ACTIVE now");
    check(/^CHOSEN: codex$/m.test(insideOut), "inside the avoid window, small falls through to codex");

    // Monday 11:00 UTC is outside the window -> zlaude again.
    const outside = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: "2026-08-10T11:00:00Z" });
    check(/^CHOSEN: zlaude$/m.test(`${outside.stdout}`),
      "outside the avoid window, small uses zlaude");

    // Saturday 07:30 UTC: the window is Mon-Fri only.
    const weekend = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: "2026-08-08T07:30:00Z" });
    check(/^CHOSEN: zlaude$/m.test(`${weekend.stdout}`),
      "the Mon-Fri window does not apply at the same time on Saturday");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 4b) Undefined rung backends are warned about and skipped ──────────────
console.log("4b) unresolvable rung backend -> warn, flag, and fall through");
{
  const profile = structuredClone(example);
  const zlaude = profile.rungs.find((r) => r.name === "zlaude");
  zlaude.builder.backend = "undefined-fixture";
  const target = makeTarget(profile);
  try {
    const explained = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: "2026-08-10T11:00:00Z" });
    const out = `${explained.stdout}${explained.stderr}`;
    check(/UNRESOLVABLE \(undefined-fixture\)/.test(out),
      "explain flags the rung UNRESOLVABLE and names its backend");
    check(/^CHOSEN: codex$/m.test(out),
      "selection skips the unresolvable rung and falls through to codex");

    const validated = spawnSync("python3", [path.join(repoRoot, ".agents", "ralph", "efficiency.py"),
      "validate", "--repo", target, "--json"], {
      encoding: "utf-8",
      env: { ...process.env, RALPH_NO_LOCAL_CONFIG: "1", AGENT_ZLAUDE_CMD: "zlaude -p",
        AGENT_DLAUDE_CMD: "dlaude -p" },
    });
    check(/UNRESOLVABLE rung backend.*undefined-fixture/.test(`${validated.stderr}`),
      "boot validation warns on stderr before dispatch");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 5) Ledger usage: caps, reserves and the near-weekly-reset relaxation ──
console.log("5) ledger usage drives caps / reserves / near-weekly-reset relaxation");
{
  const target = makeTarget(example);
  const ledgerLine = (quota) => JSON.stringify({
    run_id: "run-A",
    round: "task-001",
    timestamp: "2026-08-10T10:00:00Z",
    agents: { builder: { provider: "zlaude" }, reviewer: { provider: "zlaude" } },
    invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
    tokens: { input: 1000, output: 200, cached: 0, total: 1200 },
    quota,
  });
  try {
    // zai at 50% of its weekly window is over the 45% cap -> small falls to codex.
    writeFileSync(path.join(target, ".ralph", "ledger.jsonl"),
      ledgerLine({ pool: "zai", window_5h_pct: 10, window_weekly_pct: 50 }) + "\n");
    const over = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: "2026-08-10T11:00:00Z" });
    const overOut = `${over.stdout}`;
    check(/per-pool quota usage read from the ledger/.test(overOut),
      "reads per-pool usage from the ledger when it carries quota observations");
    check(/weekly window 50\.0% vs cap 45% — OVER CAP/.test(overOut), "flags the weekly cap breach");
    check(/^CHOSEN: codex$/m.test(overOut), "an over-cap pool is skipped");
    check(/ledger shows 1 record\(s\)/.test(overOut), "reports the ledger-observed spend for the pool");

    // The reserve is a SECOND gate, independent of the cap. Exercise it with a
    // profile whose reserve bites first: cap 90%/week, and the MANAGER (55%) parked
    // on the zai pool via RALPH_MANAGER_POOL (#63) -> 50% used is under the cap but
    // leaves only 50% against a 55% reserve.
    const reserveFirst = {
      rungs: [
        {
          name: "zlaude",
          builder: { backend: "zlaude", pool: "zai" },
          reviewer: { backend: "zlaude", pool: "zai" },
          caps: { zai: { window_5h_pct: 90, window_weekly_pct: 90 } },
        },
        {
          name: "codex",
          builder: { backend: "codex", pool: "openai" },
          reviewer: { backend: "codex-readonly", pool: "openai" },
          caps: { openai: { source: "provider" } },
        },
      ],
      reserves: { manager_pct: 55, near_weekly_reset_hours: 5 },
      tiers: {
        trivial: ["zlaude", "codex"], small: ["zlaude", "codex"],
        medium: ["zlaude", "codex"], large: ["zlaude", "codex"],
      },
    };
    const profilePath = path.join(target, ".agents", "ralph", "efficiency.json");
    writeFileSync(profilePath, JSON.stringify(reserveFirst, null, 2));
    writeFileSync(path.join(target, ".ralph", "ledger.jsonl"),
      ledgerLine({ pool: "zai", window_5h_pct: 5, window_weekly_pct: 50 }) + "\n");
    const onZai = { RALPH_EFFICIENCY_NOW: "2026-08-10T11:00:00Z", RALPH_MANAGER_POOL: "zai" };
    const reserve = ralph(["explain", "--repo", target, "--complexity", "small"], onZai);
    const reserveOut = `${reserve.stdout}`;
    check(/under cap/.test(reserveOut), "the cap itself is not breached at 50% of a 90% cap");
    check(/BELOW RESERVE/.test(reserveOut), "flags the reserve breach (50% left vs 55% reserve)");
    check(/^CHOSEN: codex$/m.test(reserveOut), "a below-reserve pool is skipped");
    check(/reserve: manager -> pool zai \(RALPH_MANAGER_POOL\)/.test(reserveOut),
      "explain names the pool the manager's reserve followed it onto");

    // Same usage, but the weekly window resets in 4h (<= near_weekly_reset_hours=5)
    // -> the reserve is relaxed and zlaude becomes eligible again.
    writeFileSync(path.join(target, ".ralph", "ledger.jsonl"),
      ledgerLine({
        pool: "zai", window_5h_pct: 5, window_weekly_pct: 50,
        weekly_reset_at: "2026-08-10T15:00:00Z",
      }) + "\n");
    const relaxed = ralph(["explain", "--repo", target, "--complexity", "small"], onZai);
    const relaxedOut = `${relaxed.stdout}`;
    check(/reserve 55% RELAXED/.test(relaxedOut), "relaxes the reserve near the weekly reset");
    check(/^CHOSEN: zlaude$/m.test(relaxedOut), "the relaxed rung is chosen again");

    // Far from the reset, the same numbers block again (the relaxation is not sticky).
    const farFromReset = ralph(["explain", "--repo", target, "--complexity", "small"],
      { ...onZai, RALPH_EFFICIENCY_NOW: "2026-08-10T09:00:00Z" });
    check(/^CHOSEN: codex$/m.test(`${farFromReset.stdout}`),
      "6h before the reset (> 5h) the reserve still applies");

    // A ledger with spend but no quota block -> assume 0% and say so.
    writeFileSync(profilePath, JSON.stringify(example, null, 2));
    writeFileSync(path.join(target, ".ralph", "ledger.jsonl"),
      JSON.stringify({
        run_id: "run-B", round: "task-002", timestamp: "2026-08-10T10:00:00Z",
        agents: { builder: { provider: "zlaude" }, reviewer: { provider: "zlaude" } },
        invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
        tokens: { input: 1000, output: 200, cached: 0, total: 1200 },
      }) + "\n");
    const noQuota = ralph(["explain", "--repo", target, "--complexity", "small"],
      { RALPH_EFFICIENCY_NOW: "2026-08-10T11:00:00Z" });
    check(/no quota observations[\s\S]*assuming 0% used/.test(`${noQuota.stdout}`),
      "a ledger without quota observations falls back to 0% and says so");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 6) Malformed / invalid profiles are REJECTED to a safe inert state ────
console.log("6) malformed / invalid profile -> rejected to safe (never crashes)");
{
  const cases = [
    ["unparseable JSON", "{ not json at all"],
    ["root is not an object", "[]"],
    ["missing rungs", { reserves: {}, tiers: { trivial: [], small: [], medium: [], large: [] } }],
    ["unknown cap shape", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "x", pool: "p" },
        caps: { p: { window_5h_pct: 50 } },
      }],
      reserves: { near_weekly_reset_hours: 5 },
      tiers: { trivial: ["a"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
    ["out-of-range percentage", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "x", pool: "p" },
        caps: { p: { window_5h_pct: 500, window_weekly_pct: 10 } },
      }],
      reserves: { near_weekly_reset_hours: 5 },
      tiers: { trivial: ["a"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
    ["tier names an unknown rung", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "x", pool: "p" },
        caps: { p: { backstop: true } },
      }],
      reserves: { near_weekly_reset_hours: 5 },
      tiers: { trivial: ["ghost"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
    ["non-UTC avoid window", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "x", pool: "p" },
        caps: { p: { backstop: true } },
        avoid_windows: [{ from: "06:00", to: "10:00", tz: "Europe/Paris", days: "Mon-Fri", reason: "peak" }],
      }],
      reserves: { near_weekly_reset_hours: 5 },
      tiers: { trivial: ["a"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
    ["cap missing for a pool the rung uses", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "y", pool: "q" },
        caps: { p: { backstop: true } },
      }],
      reserves: { near_weekly_reset_hours: 5 },
      tiers: { trivial: ["a"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
    ["missing tier", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "x", pool: "p" },
        caps: { p: { backstop: true } },
      }],
      reserves: {},
      tiers: { trivial: ["a"] },
    }],
    // #63 retired the pool-keyed spelling; a profile still using it is rejected to
    // safe rather than half-honoured.
    ["pool-keyed reserve", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "x", pool: "p" },
        caps: { p: { backstop: true } },
      }],
      reserves: { anthropic_weekly_pct: 25, near_weekly_reset_hours: 5 },
      tiers: { trivial: ["a"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
    ["unknown reserve role", {
      rungs: [{
        name: "a", builder: { backend: "x", pool: "p" }, reviewer: { backend: "x", pool: "p" },
        caps: { p: { backstop: true } },
      }],
      reserves: { builder_pct: 10 },
      tiers: { trivial: ["a"], small: ["a"], medium: ["a"], large: ["a"] },
    }],
  ];
  for (const [label, profile] of cases) {
    const target = makeTarget(profile);
    try {
      const r = ralph(["explain", "--repo", target, "--complexity", "medium"]);
      const out = `${r.stdout}`;
      const err = `${r.stderr}`;
      check(r.status === 0, `${label}: exits 0 (never crashes the harness)`);
      check(/REJECTED efficiency profile/.test(err), `${label}: loud REJECTED warning on stderr`);
      check(/inert/i.test(err), `${label}: stderr says it fell back to inert/off`);
      check(/efficiency mode: OFF \(inert\)/.test(out), `${label}: stdout reports efficiency mode OFF`);
      check(!/^CHOSEN: /m.test(out), `${label}: nothing is chosen from a rejected profile`);
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
}

// ── 7) A missing profile is a clean not-configured message ───────────────
console.log("7) missing profile -> clean not-configured message");
{
  const target = makeTarget();
  try {
    for (const args of [["explain", "--complexity", "medium"], ["explain", "--complexity", "trivial"]]) {
      const r = ralph([...args, "--repo", target]);
      const out = `${r.stdout}`;
      check(r.status === 0, `${args.join(" ")}: exits 0 when no profile is configured`);
      check(/efficiency profile not configured/.test(out), `${args.join(" ")}: clean not-configured message`);
      check(!/REJECTED/.test(`${r.stderr}`), `${args.join(" ")}: a missing profile is not a rejection`);
      check(/efficiency mode: OFF \(inert\)/.test(out), `${args.join(" ")}: reports inert fallback`);
    }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 8) explain CLI contract: bad usage, --json, --profile override ────────
console.log("8) explain CLI contract");
{
  const target = makeTarget(example);
  try {
    const missing = ralph(["explain", "--repo", target]);
    check(missing.status === 2, "explain without --complexity exits 2");
    check(/needs --complexity/.test(`${missing.stderr}`), "explain without --complexity explains itself");

    const bogus = ralph(["explain", "--repo", target, "--complexity", "enormous"]);
    check(bogus.status === 2, "explain with an unknown complexity exits 2");
    check(/unknown complexity/.test(`${bogus.stderr}`), "explain names the valid complexities");

    const json = ralph(["explain", "--repo", target, "--complexity", "medium", "--json"],
      { RALPH_EFFICIENCY_NOW: "2026-08-09T12:00:00Z" });
    check(json.status === 0, "explain --json exits 0");
    const data = JSON.parse(`${json.stdout}`);
    check(data.chosen === "codex", "JSON: chosen rung");
    check(data.enforced === false, "JSON: enforced=false (governs nothing)");
    check(Array.isArray(data.order) && data.order.join(",") === "codex,claude,deepseek",
      "JSON: the tier order is reported");
    check(Array.isArray(data.rungs) && data.rungs.every((r) => Array.isArray(r.checks)),
      "JSON: per-rung eligibility checks are reported");

    // --profile <path> on explain points at an arbitrary profile file.
    const elsewhere = ralph(["explain", "--repo", target, "--complexity", "small",
      "--profile", examplePath], { RALPH_EFFICIENCY_NOW: "2026-08-09T12:00:00Z" });
    check(elsewhere.status === 0 && new RegExp(examplePath).test(`${elsewhere.stdout}`),
      "explain --profile <path> reads the named profile");

    const help = ralph(["--help"]);
    check(/explain --complexity/.test(`${help.stdout}`), "help documents the explain command");
    check(/--efficiency\b/.test(`${help.stdout}`), "help documents the --efficiency opt-in");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 9) --efficiency on an UNSIZED story leaves dispatch alone ────────────
console.log("9) --efficiency on a story with no complexity: dispatch is UNCHANGED");
{
  // A dry-run `ralph review` with and without --efficiency must resolve the SAME
  // backends and reach the same outcome when the story carries no complexity:<tier>
  // — #62 right-sizes a ticket only when the ticket says how big it is.
  const mkRepo = (profile) => {
    const target = makeTarget(profile);
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
  const runReview = (target, extraArgs, env) => ralph(
    ["review", "1", "--repo", target, "--builder", "fixture-build",
      "--reviewer", "fixture-review", "--max-iterations", "1", "--check", "true", ...extraArgs],
    {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: worktreeFor(target),
      AGENT_FIXTURE_BUILD_CMD: "opencode run {prompt}",
      AGENT_FIXTURE_REVIEW_CMD: "claude -p",
      ...env,
    },
  );
  const cleanup = (target) => {
    rmSync(worktreeFor(target), { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  };
  // The one line that states the resolved dispatch for the whole run.
  const selection = (out) => (out.match(/^\s*Agents: .*$/m) || [""])[0];

  const plain = mkRepo(example);
  const opted = mkRepo(example);
  const broken = mkRepo("{ broken");
  try {
    const a = runReview(plain, [], {});
    const b = runReview(opted, ["--efficiency"], {});
    const aOut = `${a.stdout}${a.stderr}`;
    const bOut = `${b.stdout}${b.stderr}`;
    check(a.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(aOut), "baseline run reaches READY");
    check(/efficiency mode: recognized/.test(bOut), "--efficiency is recognized by the loop");
    check(/is VALID/.test(bOut), "the opt-in run boot-validates the profile");
    check(/carries no complexity:<tier> label\/field/.test(bOut),
      "the opt-in run says loudly why it could not right-size this story");
    check(!/efficiency (mode|profile)|RALPH_EFFICIENCY/i.test(aOut),
      "without the opt-in nothing about efficiency mode is printed");
    check(selection(aOut) !== "" && selection(aOut) === selection(bOut),
      "builder/reviewer selection is identical with and without --efficiency");
    check(a.status === b.status && /READY_FOR_HUMAN_REVIEW/.test(bOut),
      "the opt-in does not change the run outcome");

    // A REJECTED profile must not take the run down either.
    const c = runReview(broken, [], { RALPH_EFFICIENCY: "1" });
    const cOut = `${c.stdout}${c.stderr}`;
    check(/REJECTED efficiency profile/.test(cOut), "a bad profile is rejected at boot");
    check(/OFF \(inert\)/.test(cOut), "the loop reports the inert fallback");
    check(c.status === a.status && /READY_FOR_HUMAN_REVIEW/.test(cOut),
      "a bad profile does not crash or change the run outcome");
    check(selection(cOut) === selection(aOut), "a bad profile leaves selection unchanged");
  } finally {
    cleanup(plain);
    cleanup(opted);
    cleanup(broken);
  }
}

console.log(`\nefficiency: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
