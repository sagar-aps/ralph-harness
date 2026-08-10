// Tests for `ralph pick-driver` — usage-aware DRIVER selection (#76).
//
// The operator's cron picks the orchestrator driver by the clock, which is blind to
// the live numbers. This entry point reads the SAME per-pool usage the rest of the
// harness reads (usage-state.py's ledger-vs-budget estimate and the #68
// usage_provider adapters), measures each candidate against its cap and the
// reserves OTHER control-plane roles hold on its pool, and prints the candidate
// with the most headroom.
//
// What is pinned here:
//   * the pick follows the usage, not the order the candidates were given;
//   * a #68 adapter's percentages drive it with no ledger and no token budget;
//   * FAIL-OPEN: no usage anywhere / a broken adapter / a rejected profile => the
//     documented default (RALPH_CRON_DRIVER, or --default), exit 0, said out loud;
//   * READ-ONLY: the target repo is byte-for-byte unchanged, ledger included;
//   * the stdout contract: ONLY the driver name, so $(ralph pick-driver) is usable.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");
const templateDir = path.join(repoRoot, ".agents", "ralph");
const pickScript = path.join(templateDir, "pick-driver.py");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
}

// ── Fixture ───────────────────────────────────────────────────────────────
// "now" for every run below: Monday 2026-08-10 11:00 UTC. The weekly window is
// anchored at Wed 2026-08-05 09:00 UTC, so it resets 46h later (no relaxation).
const NOW = "2026-08-10T11:00:00Z";
const ANCHOR = "2026-08-05T09:00:00Z";
const STUB = "usage_provider_stub.sh";

const ledgerLine = (timestamp, total, provider) => JSON.stringify({
  run_id: "run-A",
  round: "task-001",
  timestamp,
  agents: { builder: { provider }, reviewer: { provider } },
  invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
  tokens: { input: total, output: 0, cached: 0, total },
});

// A two-rung ladder: zai (metered from the ledger vs a token budget) and openai
// (same). Caps are generous so the ledger numbers, not the caps, decide.
function budgetProfile({ zai5h = 20000, openai5h = 10000 } = {}) {
  const cap = (fiveH) => ({
    window_5h_pct: 90, window_weekly_pct: 90,
    window_5h_budget_tokens: fiveH, window_weekly_budget_tokens: 100000,
    weekly_reset_anchor: ANCHOR,
  });
  return {
    rungs: [
      {
        name: "zlaude",
        builder: { backend: "zlaude", pool: "zai" },
        reviewer: { backend: "zlaude", pool: "zai" },
        caps: { zai: cap(zai5h) },
      },
      {
        name: "codex",
        builder: { backend: "codex", pool: "openai" },
        reviewer: { backend: "codex", pool: "openai" },
        caps: { openai: cap(openai5h) },
      },
    ],
    reserves: { manager_pct: 25, orchestrator_pct: 50, near_weekly_reset_hours: 5 },
    tiers: {
      trivial: ["zlaude", "codex"], small: ["zlaude", "codex"],
      medium: ["zlaude", "codex"], large: ["zlaude", "codex"],
    },
  };
}

function makeTarget(prof, ledger = null, { stub = null } = {}) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-pick-"));
  mkdirSync(path.join(target, ".agents", "ralph"), { recursive: true });
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  if (prof !== null) {
    writeFileSync(path.join(target, ".agents", "ralph", "efficiency.json"),
      typeof prof === "string" ? prof : JSON.stringify(prof, null, 2));
  }
  if (ledger !== null) writeFileSync(path.join(target, ".ralph", "ledger.jsonl"), ledger);
  if (stub !== null) writeFileSync(path.join(target, STUB), stub, { mode: 0o755 });
  return target;
}

// Nothing an outer ralph run exported may leak in: the fixture decides the profile,
// the clock, the manager's pool and what RALPH_CRON_DRIVER resolves to.
const cleanEnv = (env = {}) => ({
  ...process.env,
  RALPH_SKIP_UPDATE_CHECK: "1",
  RALPH_NO_LOCAL_CONFIG: "1",
  TARGET_REPO: "", PRD_PATH: "", TASK_ID: "", TASK_INDEX: "", BRANCH: "",
  BUILDER: "", REVIEWER: "", RALPH_PROFILE: "",
  RALPH_EFFICIENCY: "", RALPH_EFFICIENCY_PROFILE: "",
  RALPH_EFFICIENCY_NOW: NOW,
  RALPH_MANAGER_POOL: "anthropic",
  RALPH_CRON_DRIVER: "", RALPH_CRON_DRIVER_DEFAULT: "", RALPH_CRON_DRIVER_PROVIDER: "",
  RALPH_CRON_DRIVER_CANDIDATES: "",
  RALPH_QUOTA_OPEN_CIRCUITS: "",
  ...env,
});

const ralph = (args, env = {}) =>
  spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf-8", env: cleanEnv(env) });

const pick = (target, args = [], env = {}) =>
  ralph(["pick-driver", "--repo", target, ...args], env);

const pickJson = (target, args = [], env = {}) => {
  const r = pick(target, [...args, "--json"], env);
  if (r.status !== 0) throw new Error(`pick-driver failed (${r.status}): ${r.stderr}`);
  return JSON.parse(`${r.stdout}`);
};

const candidate = (result, name) => result.candidates.find((c) => c.name === name);

// Every file under a directory, with its contents — for the read-only assertion.
function snapshot(dir) {
  const out = {};
  const walk = (base) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = readFileSync(full, "utf-8");
    }
  };
  walk(dir);
  return out;
}

const stubPrinting = (payload) =>
  `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`;

// A %-only ladder: both pools report their percentages through an adapter (#68),
// which is the case a token budget can never cover (Anthropic Pro/Max).
function providerProfile(zaiStub, anthropicStub) {
  const cap = (script) => ({
    source: "provider_pct", usage_provider: script,
    window_5h_pct: 90, window_weekly_pct: 90,
  });
  return {
    rungs: [
      {
        name: "zlaude",
        builder: { backend: "zlaude", pool: "zai" },
        reviewer: { backend: "zlaude", pool: "zai" },
        caps: { zai: cap(zaiStub) },
      },
      {
        name: "claude",
        builder: { backend: "claude", pool: "anthropic" },
        reviewer: { backend: "claude", pool: "anthropic" },
        caps: { anthropic: cap(anthropicStub) },
      },
    ],
    reserves: { manager_pct: 25, orchestrator_pct: 50, near_weekly_reset_hours: 5 },
    tiers: {
      trivial: ["zlaude", "claude"], small: ["zlaude", "claude"],
      medium: ["zlaude", "claude"], large: ["zlaude", "claude"],
    },
  };
}

// ── 1) The point of the issue: the pick follows live usage, not the order ──
console.log("1) picks the pool with the most live headroom, whatever order it is given in");
{
  // zai: 2000/20000 = 10% of the 5h window. openai: 9500/10000 = 95%.
  const LEDGER = [
    ledgerLine("2026-08-10T10:00:00Z", 2000, "zlaude"),
    ledgerLine("2026-08-10T10:00:00Z", 9500, "codex"),
  ].join("\n") + "\n";
  const target = makeTarget(budgetProfile(), LEDGER);
  try {
    // codex is named FIRST (what a calendar rule would have picked at this hour).
    const result = pickJson(target, ["--candidates", "codex,zlaude"]);
    check(result.status === "selected", "status is 'selected' — a live number decided it");
    check(result.driver === "zlaude" && result.pool === "zai",
      "the 10%-used zai pool wins over the 95%-used openai pool named first");
    const zai = candidate(result, "zlaude");
    const openai = candidate(result, "codex");
    check(zai.used_5h_pct === 10 && openai.used_5h_pct === 95,
      "the per-pool 5h percentages come from the ledger vs the profile's budgets");
    check(zai.pct_source_5h === "budget" && zai.pct_source_weekly === "budget",
      "…and each says where it came from (the local budget estimate)");
    check(zai.headroom_pct === 80 && zai.binding_window === "5h",
      "zai headroom = 90% cap - 10% used = 80 points, and the 5h window binds");
    check(openai.headroom_pct === -5,
      "openai is 5 points OVER its cap, so its headroom is negative");
    check(result.headroom_pct === 80, "the winner's headroom is reported");
    check(/most live headroom/.test(result.reason), "the reason names the criterion");

    // Plain mode: stdout is ONLY the name, so $(ralph pick-driver) is directly usable.
    const plain = pick(target, ["--candidates", "codex,zlaude"]);
    check(plain.status === 0, "exits 0");
    check(`${plain.stdout}` === "zlaude\n", "stdout is exactly the driver name");
    check(/PICKED: zlaude \(pool zai\)/.test(`${plain.stderr}`),
      "the reasoning goes to stderr, where an operator still sees it");
    check(/READ-ONLY — nothing was dispatched/.test(`${plain.stderr}`),
      "…and says it dispatched nothing");

    // Flip the usage and the pick flips with it — the clock never enters into it.
    const flipped = makeTarget(budgetProfile(), [
      ledgerLine("2026-08-10T10:00:00Z", 19000, "zlaude"),
      ledgerLine("2026-08-10T10:00:00Z", 1000, "codex"),
    ].join("\n") + "\n");
    try {
      const r = pickJson(flipped, ["--candidates", "codex,zlaude"]);
      check(r.driver === "codex", "with zai at 95% and openai at 10%, codex wins instead");
    } finally { rmSync(flipped, { recursive: true, force: true }); }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 2) #68 adapters drive it, with no ledger and no token budget ───────────
console.log("2) a stub usage_provider decides it — no ledger, no budget anywhere");
{
  const ZAI_STUB = "zai_stub.sh";
  const ANT_STUB = "anthropic_stub.sh";
  const target = makeTarget(providerProfile(ZAI_STUB, ANT_STUB), null);
  writeFileSync(path.join(target, ZAI_STUB),
    stubPrinting({ window_5h_pct: 88, window_weekly_pct: 60, weekly_reset_at: "2026-08-14T09:00:00Z" }),
    { mode: 0o755 });
  writeFileSync(path.join(target, ANT_STUB),
    stubPrinting({ window_5h_pct: 20, window_weekly_pct: 30, weekly_reset_at: "2026-08-14T09:00:00Z" }),
    { mode: 0o755 });
  try {
    const result = pickJson(target, ["--candidates", "zlaude,claude"]);
    const zai = candidate(result, "zlaude");
    const ant = candidate(result, "claude");
    check(zai.pct_source_5h === "provider_pct" && ant.pct_source_5h === "provider_pct",
      "both percentages are provider-reported (via each pool's usage_provider)");
    check(result.ledger === null, "there is no ledger at all — the adapters are enough");
    check(zai.headroom_pct === 2 && zai.binding_window === "5h",
      "zai: 90% cap - 88% used = 2 points of 5h headroom");
    // anthropic carries the manager's 25% weekly reserve: ceiling 75%, used 30%.
    check(ant.reserve_pct === 25 && ant.ceiling_weekly_pct === 75,
      "the manager's 25% weekly reserve lowers the anthropic weekly ceiling to 75%");
    check(ant.headroom_pct === 45 && ant.binding_window === "weekly",
      "…so anthropic's binding headroom is 75 - 30 = 45 points");
    check(result.driver === "claude", "the pool with more live headroom is picked");
    check(result.reserves.anthropic === 25 && result.reserves.zai === undefined,
      "reserves are reported per pool, and only where a role actually sits");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 3) The driver is not charged its OWN reserve, but is charged the others' ─
console.log("3) the orchestrator's own reserve is not charged against the driver");
{
  const ZAI_STUB = "zai_stub.sh";
  const ANT_STUB = "anthropic_stub.sh";
  const prof = providerProfile(ZAI_STUB, ANT_STUB);
  const target = makeTarget(prof, null);
  writeFileSync(path.join(target, ZAI_STUB),
    stubPrinting({ window_5h_pct: 10, window_weekly_pct: 40, weekly_reset_at: "2026-08-14T09:00:00Z" }),
    { mode: 0o755 });
  writeFileSync(path.join(target, ANT_STUB),
    stubPrinting({ window_5h_pct: 10, window_weekly_pct: 40, weekly_reset_at: "2026-08-14T09:00:00Z" }),
    { mode: 0o755 });
  try {
    // The cron driver currently resolves onto the zai pool (zlaude is a zai
    // backend in the profile), so #63 would put the orchestrator's 50% reserve
    // there. A driver hiding from its own reserve would rule zai out.
    const env = { RALPH_CRON_DRIVER: "zlaude", RALPH_MANAGER_POOL: "anthropic" };
    const result = pickJson(target, ["--candidates", "zlaude,claude"], env);
    check(result.roles.orchestrator.pool === "zai",
      "the resolved orchestrator pool is zai (RALPH_CRON_DRIVER=zlaude)");
    check(candidate(result, "zlaude").reserve_pct === null,
      "zai carries NO reserve for this decision — that 50% is the driver's own");
    check(candidate(result, "claude").reserve_pct === 25,
      "…while the manager's 25% on anthropic still binds");
    check(candidate(result, "zlaude").headroom_pct === 50
      && candidate(result, "claude").headroom_pct === 35,
      "so equal usage leaves zai (50) with more headroom than anthropic (35)");
    check(result.driver === "zlaude", "and zai is picked");
    check(result.notes.some((n) => /orchestrator's own weekly reserve is NOT charged/.test(n)),
      "the record says so rather than leaving it implicit");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 4) FAIL-OPEN: usage unavailable for ALL candidates -> documented default ─
console.log("4) all candidates unavailable -> the documented default, never an error");
{
  // (a) No profile at all: nothing maps a candidate to a pool, so nothing can be
  //     measured. The default is whatever RALPH_CRON_DRIVER resolves to.
  const bare = makeTarget(null, null);
  try {
    const r = pick(bare, ["--candidates", "codex,zlaude"], { RALPH_CRON_DRIVER: "codex" });
    check(r.status === 0, "exits 0 — a missing profile is never an error here");
    check(`${r.stdout}` === "codex\n", "prints the RALPH_CRON_DRIVER default");
    check(/FAIL-OPEN DEFAULT: codex/.test(`${r.stderr}`), "and says it is a fallback");
    const result = pickJson(bare, ["--candidates", "codex,zlaude"], { RALPH_CRON_DRIVER: "codex" });
    check(result.status === "default", "status is 'default'");
    check(/RALPH_CRON_DRIVER resolves to 'codex'/.test(result.default_source),
      "the default's provenance is named (agents.sh's own resolver)");
    check(result.candidates.every((c) => c.ranked === false),
      "no candidate was ranked");

    // With nothing set anywhere, the documented chain still answers (-> codex).
    const unset = pickJson(bare, ["--candidates", "zlaude"]);
    check(unset.driver === "codex",
      "unset RALPH_CRON_DRIVER falls through the documented chain to $DEFAULT_AGENT (codex)");

    // --default is the caller's own rule (its calendar rule) and wins.
    const calendar = pickJson(bare, ["--candidates", "codex,zlaude", "--default", "zlaude"],
      { RALPH_CRON_DRIVER: "codex" });
    check(calendar.driver === "zlaude" && /calendar rule/.test(calendar.default_source),
      "--default overrides it, for the calendar rule the cron used before");
  } finally { rmSync(bare, { recursive: true, force: true }); }

  // (b) A profile with pools but no budgets and no adapters: pools resolve, yet no
  //     percentage exists for either window — still fail-open, not a 0% guess.
  const noBudgets = makeTarget({
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
        reviewer: { backend: "codex", pool: "openai" },
        caps: { openai: { source: "provider" } },
      },
    ],
    reserves: { near_weekly_reset_hours: 5 },
    tiers: {
      trivial: ["zlaude"], small: ["zlaude"], medium: ["zlaude"], large: ["zlaude"],
    },
  }, [ledgerLine("2026-08-10T10:00:00Z", 2000, "zlaude")].join("\n") + "\n");
  try {
    const result = pickJson(noBudgets, ["--candidates", "codex,zlaude"],
      { RALPH_CRON_DRIVER: "codex" });
    check(result.status === "default" && result.driver === "codex",
      "known pools but no percentages anywhere -> the default");
    check(candidate(result, "zlaude").pool === "zai",
      "the pool was still resolved from the profile's rungs");
    check(/no usage percentage for either window/.test(candidate(result, "zlaude").unavailable),
      "…and the candidate says a percentage was never invented for it");
  } finally { rmSync(noBudgets, { recursive: true, force: true }); }
}

// ── 5) Malformed usage: broken adapters fail open, one good one still decides ─
console.log("5) malformed / broken usage_provider output fails open");
{
  const ZAI_STUB = "zai_stub.sh";
  const ANT_STUB = "anthropic_stub.sh";
  const broken = {
    "unparseable output": "#!/usr/bin/env bash\necho 'not json at all'\n",
    "a non-zero exit": "#!/usr/bin/env bash\necho boom >&2\nexit 7\n",
    "an out-of-range percentage": stubPrinting({ window_5h_pct: 480, window_weekly_pct: "many" }),
    "no such script": null,
  };
  for (const [label, body] of Object.entries(broken)) {
    const target = makeTarget(providerProfile(ZAI_STUB, ANT_STUB), null);
    if (body !== null) writeFileSync(path.join(target, ZAI_STUB), body, { mode: 0o755 });
    // The other pool's adapter is healthy, so there IS still a usable answer.
    writeFileSync(path.join(target, ANT_STUB),
      stubPrinting({ window_5h_pct: 20, window_weekly_pct: 30, weekly_reset_at: "2026-08-14T09:00:00Z" }),
      { mode: 0o755 });
    try {
      const r = pick(target, ["--candidates", "zlaude,claude"], { RALPH_CRON_DRIVER: "codex" });
      check(r.status === 0, `${label}: exits 0 — a broken adapter never crashes it`);
      check(`${r.stdout}` === "claude\n",
        `${label}: the pool with usable usage is picked; the broken one is skipped`);
      const result = pickJson(target, ["--candidates", "zlaude,claude"], { RALPH_CRON_DRIVER: "codex" });
      check(candidate(result, "zlaude").ranked === false
        && /FAIL-OPEN/.test(candidate(result, "zlaude").unavailable),
        `${label}: the affected candidate is reported unavailable, not assumed idle`);
      check(result.usage_notes.some((n) => /FAILED OPEN/.test(n)),
        `${label}: the reader's own fail-open note is surfaced`);
    } finally { rmSync(target, { recursive: true, force: true }); }
  }

  // Every adapter broken -> the documented default, loudly.
  {
    const target = makeTarget(providerProfile(ZAI_STUB, ANT_STUB), null);
    const bad = "#!/usr/bin/env bash\necho 'not json'\n";
    writeFileSync(path.join(target, ZAI_STUB), bad, { mode: 0o755 });
    writeFileSync(path.join(target, ANT_STUB), bad, { mode: 0o755 });
    try {
      const r = pick(target, ["--candidates", "zlaude,claude"], { RALPH_CRON_DRIVER: "codex" });
      check(r.status === 0 && `${r.stdout}` === "codex\n",
        "with every adapter broken it falls back to the default and exits 0");
      check(/no candidate has usable live usage/.test(`${r.stderr}`),
        "…and explains that no candidate could be measured");
    } finally { rmSync(target, { recursive: true, force: true }); }
  }

  // A REJECTED profile: loud warning, fail-open default, still exit 0.
  {
    const target = makeTarget('{ "rungs": "nope" }', null);
    try {
      const r = pick(target, ["--candidates", "codex,zlaude"], { RALPH_CRON_DRIVER: "codex" });
      check(r.status === 0 && `${r.stdout}` === "codex\n",
        "a rejected profile falls back to the default and exits 0");
      check(/REJECTED efficiency profile/.test(`${r.stderr}`),
        "…after the same loud rejection warning the rest of the harness prints");
    } finally { rmSync(target, { recursive: true, force: true }); }
  }

  // A malformed ledger line is skipped by the reader, not fatal.
  {
    const target = makeTarget(budgetProfile(), [
      "{ this is not json",
      ledgerLine("2026-08-10T10:00:00Z", 2000, "zlaude"),
      ledgerLine("2026-08-10T10:00:00Z", 9500, "codex"),
    ].join("\n") + "\n");
    try {
      const result = pickJson(target, ["--candidates", "codex,zlaude"]);
      check(result.status === "selected" && result.driver === "zlaude",
        "a half-written ledger line is skipped, and the rest still decides");
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
}

// ── 6) Candidates a pool-level gate holds back ─────────────────────────────
console.log("6) an open #28 circuit or an active avoid window holds a candidate back");
{
  const LEDGER = [
    ledgerLine("2026-08-10T10:00:00Z", 2000, "zlaude"),
    ledgerLine("2026-08-10T10:00:00Z", 9500, "codex"),
  ].join("\n") + "\n";
  {
    const target = makeTarget(budgetProfile(), LEDGER);
    try {
      // zai has by far the most headroom, but the caller reports its circuit open.
      const result = pickJson(target,
        ["--candidates", "codex,zlaude", "--exhausted-pool", "zai"]);
      check(/circuit is OPEN/.test(candidate(result, "zlaude").blocked),
        "the exhausted pool's candidate is held back, not ranked");
      check(result.driver === "codex" && result.status === "selected",
        "…so the remaining measurable candidate is picked");
      check(result.exhausted_pools.join(",") === "zai", "the input is echoed back");
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
  {
    // An avoid window on the zai rung is active at NOW (Mon 11:00 UTC).
    const prof = budgetProfile();
    prof.rungs[0].avoid_windows = [{
      from: "06:00", to: "14:00", tz: "UTC", days: "Mon-Fri",
      reason: "3x quota burn (Z.AI peak)",
    }];
    const target = makeTarget(prof, LEDGER);
    try {
      const result = pickJson(target, ["--candidates", "codex,zlaude"]);
      check(/avoid window/.test(candidate(result, "zlaude").blocked || ""),
        "a pool inside an active avoid window is held back");
      check(result.driver === "codex", "…and the other candidate is picked");
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
  {
    // Every candidate held back -> fail-open default.
    const target = makeTarget(budgetProfile(), LEDGER);
    try {
      const r = pick(target, ["--candidates", "codex,zlaude",
        "--exhausted-pool", "zai", "--exhausted-pool", "openai"],
        { RALPH_CRON_DRIVER: "dlaude" });
      check(r.status === 0 && `${r.stdout}` === "dlaude\n",
        "with every candidate held back it falls back to the default");
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
}

// ── 7) Where the candidate list comes from, and how ties break ─────────────
console.log("7) candidate sources (flags, env, the profile's rungs) and tie-breaking");
{
  const LEDGER = [
    ledgerLine("2026-08-10T10:00:00Z", 2000, "zlaude"),
    ledgerLine("2026-08-10T10:00:00Z", 9500, "codex"),
  ].join("\n") + "\n";
  const target = makeTarget(budgetProfile(), LEDGER);
  try {
    const env = pickJson(target, [], { RALPH_CRON_DRIVER_CANDIDATES: "codex zlaude" });
    check(env.candidates_source === "RALPH_CRON_DRIVER_CANDIDATES"
      && env.driver === "zlaude",
      "RALPH_CRON_DRIVER_CANDIDATES is used when no flag is given");

    const fromProfile = pickJson(target, []);
    check(/rung backends/.test(fromProfile.candidates_source)
      && fromProfile.candidates.map((c) => c.name).join(",") === "zlaude,codex",
      "with neither, every backend the rungs declare is a candidate (cheapest first)");
    check(fromProfile.driver === "zlaude", "…and the most-headroom one still wins");

    // A pool the profile does not map can be spelled out as name=pool.
    const explicit = pickJson(target, ["--candidate", "my-driver=zai", "--candidate", "codex"]);
    check(candidate(explicit, "my-driver").pool === "zai" && explicit.driver === "my-driver",
      "name=pool attributes a backend the profile does not name");
    const unmapped = pickJson(target, ["--candidate", "my-driver", "--candidate", "codex"]);
    check(/no pool/.test(candidate(unmapped, "my-driver").unavailable || ""),
      "…without it, an unmapped backend is unavailable and says how to fix that");

    // A tie keeps the caller's preference order: both names point at ONE pool.
    const tie = pickJson(target, ["--candidates", "codex,also-codex=openai"]);
    check(tie.driver === "codex",
      "equal headroom keeps the order the candidates were given in");
    const tieFlipped = pickJson(target, ["--candidates", "also-codex=openai,codex"]);
    check(tieFlipped.driver === "also-codex", "…in either order");

    // No candidates and no profile to take them from -> the default.
    const nowhere = makeTarget(null, null);
    try {
      const r = pick(nowhere, [], { RALPH_CRON_DRIVER: "codex" });
      check(r.status === 0 && `${r.stdout}` === "codex\n",
        "no candidates anywhere -> the default, exit 0");
      check(/no candidate drivers were given/.test(`${r.stderr}`),
        "…and it says how to give it some");
    } finally { rmSync(nowhere, { recursive: true, force: true }); }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 8) Near the weekly reset the weekly ceiling is lifted (as in select) ───
console.log("8) near the weekly reset the weekly cap + reserve are relaxed");
{
  const ANT_STUB = "anthropic_stub.sh";
  const RESET = "2026-08-10T13:00:00Z";  // 2h after NOW: inside near_weekly_reset_hours=5
  const target = makeTarget(providerProfile("zai_stub.sh", ANT_STUB), null);
  // zai is nearly out of its 5h window (5 points left), so the RELAXED anthropic
  // pool is the one with more headroom — but only because of the relaxation.
  writeFileSync(path.join(target, "zai_stub.sh"),
    stubPrinting({ window_5h_pct: 85, window_weekly_pct: 50, weekly_reset_at: "2026-08-14T09:00:00Z" }),
    { mode: 0o755 });
  writeFileSync(path.join(target, ANT_STUB),
    stubPrinting({ window_5h_pct: 10, window_weekly_pct: 80, weekly_reset_at: RESET }),
    { mode: 0o755 });
  try {
    const result = pickJson(target, ["--candidates", "zlaude,claude"]);
    const ant = candidate(result, "claude");
    check(ant.relaxed === true && ant.ceiling_weekly_pct === 100,
      "2h from the weekly reset, the weekly cap and the manager reserve are lifted");
    check(ant.headroom_pct === 20 && ant.binding_window === "weekly",
      "…leaving 100 - 80 = 20 points of weekly headroom instead of a breach");
    check(result.driver === "claude" && /resets within near_weekly_reset_hours/.test(result.reason),
      "the relaxed candidate can be picked, and the reason says why it was relaxed");
    // The rolling 5h cap is a rate limit and is NEVER relaxed.
    const zai = candidate(result, "zlaude");
    check(zai.ceiling_5h_pct === 90 && zai.relaxed === false && zai.headroom_pct === 5,
      "the 5h ceiling stays the declared cap for the un-relaxed pool (85% used -> 5 left)");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 9) READ-ONLY: nothing in the target changes, and nothing is dispatched ─
console.log("9) read-only: the target repo is byte-for-byte unchanged");
{
  const LEDGER = [
    ledgerLine("2026-08-10T10:00:00Z", 2000, "zlaude"),
    ledgerLine("2026-08-10T10:00:00Z", 9500, "codex"),
  ].join("\n") + "\n";
  const target = makeTarget(budgetProfile(), LEDGER);
  try {
    const before = snapshot(target);
    const ledgerPath = path.join(target, ".ralph", "ledger.jsonl");
    const mtimeBefore = statSync(ledgerPath).mtimeMs;
    for (const args of [[], ["--json"], ["--shell"]]) {
      pick(target, ["--candidates", "codex,zlaude", ...args]);
    }
    const after = snapshot(target);
    check(JSON.stringify(before) === JSON.stringify(after),
      "no file under the target was added, removed or modified");
    check(statSync(ledgerPath).mtimeMs === mtimeBefore, "the ledger was not even touched");
    check(!existsSync(path.join(templateDir, "__pycache__")),
      "loading the sibling modules by path leaves no __pycache__ in the template dir");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 10) The shell seam and CLI contract ────────────────────────────────────
console.log("10) --shell assignments, --help and a bad option");
{
  const target = makeTarget(budgetProfile(), [
    ledgerLine("2026-08-10T10:00:00Z", 2000, "zlaude"),
    ledgerLine("2026-08-10T10:00:00Z", 9500, "codex"),
  ].join("\n") + "\n");
  try {
    const shell = pick(target, ["--candidates", "codex,zlaude", "--shell"]);
    check(shell.status === 0, "--shell exits 0");
    const assigned = {};
    for (const line of `${shell.stdout}`.trim().split("\n")) {
      const idx = line.indexOf("=");
      assigned[line.slice(0, idx)] = line.slice(idx + 1).replace(/^'|'$/g, "");
    }
    check(assigned.RALPH_PICK_DRIVER_DRIVER === "zlaude"
      && assigned.RALPH_PICK_DRIVER_STATUS === "selected"
      && assigned.RALPH_PICK_DRIVER_POOL === "zai",
      "--shell prints eval-able RALPH_PICK_DRIVER_* assignments");
    // Everything it prints must survive `eval` in a real shell.
    const evaled = spawnSync("bash", ["-c",
      `eval "$(cat)" && printf '%s|%s' "$RALPH_PICK_DRIVER_DRIVER" "$RALPH_PICK_DRIVER_STATUS"`],
      { encoding: "utf-8", input: `${shell.stdout}` });
    check(`${evaled.stdout}` === "zlaude|selected", "…and a shell can eval them safely");

    const help = spawnSync("python3", [pickScript, "--help"], { encoding: "utf-8" });
    check(help.status === 0 && /Usage: pick-driver.py/.test(`${help.stdout}`),
      "--help prints usage and exits 0");
    // Bad CLI usage is the ONE non-zero exit: a runtime miss always fails open.
    const bad = spawnSync("python3", [pickScript, "--repo", target, "--nope"],
      { encoding: "utf-8", env: cleanEnv() });
    check(bad.status === 2, "an unknown option exits 2 (bad CLI usage, unlike a runtime miss)");
    check(/unknown pick-driver option/.test(`${bad.stderr}`), "…and says which one");
    const missing = spawnSync("python3", [pickScript, "--candidates"],
      { encoding: "utf-8", env: cleanEnv() });
    check(missing.status === 2, "a flag with no value exits 2");

    const cliHelp = ralph(["help"]);
    check(/pick-driver/.test(`${cliHelp.stdout}`), "ralph help lists pick-driver");
    check(/--candidates <a,b>/.test(`${cliHelp.stdout}`), "…with its own options block");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 11) Documented in the operator reference ───────────────────────────────
console.log("11) docs/OPERATING.md documents it as the supported method");
{
  const doc = readFileSync(path.join(repoRoot, "docs", "OPERATING.md"), "utf-8");
  check(/ralph pick-driver/.test(doc), "OPERATING.md names `ralph pick-driver`");
  check(/RALPH_CRON_DRIVER_CANDIDATES/.test(doc), "…documents the candidate env var");
  check(/pick-driver/.test(doc.slice(doc.indexOf("## 1. Defaults"), doc.indexOf("## 2. Roles"))),
    "…and it appears in the defaults / opt-in table");
}

console.log(`\npick-driver: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
