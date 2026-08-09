// Tests for #62 — efficiency mode WIRED INTO DISPATCH, opt-in, default OFF.
//
// The slice has exactly two halves, and both are pinned here:
//   1. With --efficiency, a ticket carrying a complexity:<tier> is dispatched on the
//      rung ralph_efficiency_select picks for the SEEDED ledger/pool state — proven by
//      the resolved BUILDER/REVIEWER, the recorded reason, and the PR/handoff body.
//   2. WITHOUT --efficiency nothing changes. That half is the sacred one: the co-agent
//      runs this harness off main with no flag, so the default path is compared
//      byte-for-byte against a run of a repo that has no profile at all.
// No real agents run (RALPH_DRY_RUN=1); the fixtures decide every input.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync }
  from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
}

// Sunday 2026-08-09 12:00 UTC. The fixture profile has no avoid windows, so the only
// clock-sensitive rule left is the near-weekly-reset relaxation, kept far away.
const NOW = "2026-08-09T12:00:00Z";
const RESET = "2026-08-12T09:00:00Z";

// Backends named so nothing in the harness can special-case them (no "claude"/"codex"
// substring => no usage-JSON flag rewriting, no codex sandbox handling).
const BACKEND_ENV = {
  AGENT_FIXTURE_CHEAP_CMD: "fixture-cheap-bin {prompt}",
  AGENT_FIXTURE_MID_CMD: "fixture-mid-bin {prompt}",
  AGENT_FIXTURE_MID_RO_CMD: "fixture-mid-ro-bin {prompt}",
  AGENT_FIXTURE_STRONG_CMD: "fixture-strong-bin {prompt}",
  AGENT_FIXTURE_BACKSTOP_CMD: "fixture-backstop-bin {prompt}",
  AGENT_DEFAULT_BUILD_CMD: "default-build-bin {prompt}",
  AGENT_DEFAULT_REVIEW_CMD: "default-review-bin {prompt}",
};

const cleanEnv = (env = {}) => ({
  ...process.env,
  RALPH_SKIP_UPDATE_CHECK: "1",
  RALPH_NO_LOCAL_CONFIG: "1",
  // Scrub anything an outer ralph run exported, so only the fixture decides.
  TARGET_REPO: "", PRD_PATH: "", TASK_ID: "", TASK_INDEX: "", BRANCH: "",
  BUILDER: "", REVIEWER: "", RALPH_PROFILE: "", PREVIEW_ENABLED: "",
  BUILDER_PROVIDER: "", BUILDER_MODEL: "", REVIEWER_PROVIDER: "", REVIEWER_MODEL: "",
  RALPH_EFFICIENCY: "", RALPH_EFFICIENCY_PROFILE: "",
  RALPH_EFFICIENCY_DISPATCH_STATE: "", RALPH_QUOTA_OPEN_CIRCUITS: "",
  // #63: the role-based reserves land wherever these knobs point them.
  RALPH_CRON_DRIVER: "", RALPH_CRON_DRIVER_DEFAULT: "", RALPH_CRON_DRIVER_PROVIDER: "",
  RALPH_CRON_DRIVER_MODEL: "", RALPH_CRON_DRIVER_EFFORT: "", RALPH_MANAGER_POOL: "",
  RALPH_EFFICIENCY_NOW: NOW,
  ...BACKEND_ENV,
  ...env,
});

// A four-rung ladder: one rung per pool, so a seeded pool state maps 1:1 to a rung.
const PROFILE = {
  rungs: [
    {
      name: "cheap",
      builder: { backend: "fixture-cheap", pool: "zai" },
      reviewer: { backend: "fixture-cheap", pool: "zai" },
      caps: { zai: { window_5h_pct: 70, window_weekly_pct: 45 } },
    },
    {
      name: "mid",
      builder: { backend: "fixture-mid", pool: "openai" },
      reviewer: { backend: "fixture-mid-ro", pool: "openai" },
      caps: { openai: { window_5h_pct: 80, window_weekly_pct: 80 } },
    },
    {
      name: "strong",
      builder: { backend: "fixture-strong", pool: "anthropic" },
      reviewer: { backend: "fixture-strong", pool: "anthropic" },
      caps: { anthropic: { window_5h_pct: 80, window_weekly_pct: 75 } },
    },
    {
      name: "backstop",
      builder: { backend: "fixture-backstop", pool: "deepseek" },
      reviewer: { backend: "fixture-backstop", pool: "deepseek" },
      caps: { deepseek: { backstop: true } },
    },
  ],
  // Role-keyed since #63: the manager sits on anthropic by default; the fixture
  // backends are not the cron driver, so no orchestrator reserve lands here.
  reserves: { manager_pct: 25, orchestrator_pct: 50, near_weekly_reset_hours: 5 },
  tiers: {
    trivial: ["backstop", "cheap"],
    small: ["cheap", "mid"],
    medium: ["mid", "strong"],
    large: ["strong", "backstop"],
  },
};

// A ledger line stating one pool's window usage (the #60 reader treats a `quota`
// block as the closest thing to a provider-reported number).
const quotaLine = (quota) => JSON.stringify({
  run_id: "seed", round: "task-001", timestamp: "2026-08-09T11:00:00Z",
  agents: { builder: { provider: "seed" }, reviewer: { provider: "seed" } },
  invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
  tokens: { input: 10, output: 10, cached: 0, total: 20 },
  quota,
});

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A target repo with one PRD story. `complexity` is whatever the caller wants on it
// (a field, a label, or nothing at all); `profile` may be an object, a raw string
// (to fixture a malformed one) or null for "no profile file".
function makeTarget({ profile = PROFILE, story = {}, ledger = [] } = {}) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-eff-disp-"));
  mkdirSync(path.join(target, ".agents", "ralph"), { recursive: true });
  mkdirSync(path.join(target, ".agents", "tasks"), { recursive: true });
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  if (profile !== null) {
    writeFileSync(path.join(target, ".agents", "ralph", "efficiency.json"),
      typeof profile === "string" ? profile : JSON.stringify(profile, null, 2));
  }
  if (ledger.length) {
    writeFileSync(path.join(target, ".ralph", "ledger.jsonl"), ledger.join("\n") + "\n");
  }
  writeFileSync(path.join(target, ".agents", "tasks", "prd.json"), JSON.stringify({
    version: 1,
    project: "Target",
    stories: [{ id: "US-001", title: "A story", status: "open", acceptanceCriteria: ["a"], ...story }],
  }, null, 2));
  writeFileSync(path.join(target, "README.md"), "# Target\n");
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  return target;
}

const wtBase = (target) => path.join(target, "..", `ralph-wt-${path.basename(target)}`);
function cleanup(target) {
  rmSync(wtBase(target), { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}

function runReview(target, extraArgs = [], env = {}) {
  const r = spawnSync(process.execPath, [cliPath, "review", "1", "--repo", target,
    "--builder", "default-build", "--reviewer", "default-review",
    "--max-iterations", "1", "--check", "true", ...extraArgs],
  { encoding: "utf-8", env: cleanEnv({ RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target), ...env }) });
  return { ...r, out: `${r.stdout}${r.stderr}` };
}

const runDirOf = (target) => {
  const runs = path.join(target, ".ralph", "runs");
  const dirs = readdirSync(runs).sort();
  return path.join(runs, dirs[dirs.length - 1]);
};
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf-8") : "");
const lastRun = (target) => readIf(path.join(target, ".ralph", "last-run.env"));

// ── 1) --efficiency dispatches the rung the seeded state selects ─────────
console.log("1) --efficiency: the ticket's complexity + the seeded state choose the rung");
{
  const target = makeTarget({ story: { complexity: "small" } });
  try {
    const r = runReview(target, ["--efficiency"]);
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out), "the run completes normally");
    check(/builder=fixture-cheap\s+reviewer=fixture-cheap/.test(r.out),
      "small dispatches the cheapest eligible rung (cheap), overriding --builder/--reviewer");

    const cfg = readIf(path.join(runDirOf(target), "config.resolved.env"));
    check(/^BUILDER=fixture-cheap\b/m.test(cfg) && /^REVIEWER=fixture-cheap\b/m.test(cfg),
      "the resolved-config snapshot records the rung's backends");
    check(/^BUILDER=fixture-cheap +CMD=fixture-cheap-bin/m.test(cfg),
      "the rung's backend command is resolved for the builder");
    check(/^EFFICIENCY=efficiency: rung cheap \(complexity small\)/m.test(cfg),
      "the snapshot records the chosen rung and tier");

    const status = readIf(path.join(runDirOf(target), "final_status.md"));
    check(/- Builder backend: fixture-cheap /.test(status) && /- Reviewer backend: fixture-cheap /.test(status),
      "the PR/handoff body attributes the run to the chosen agent");
    check(/- efficiency: rung cheap \(complexity small\) -> builder fixture-cheap \(pool zai\)/.test(status),
      "the PR/handoff body names the rung, tier and pools");
    check(/cheapest rung in tier 'small'/.test(status), "the PR/handoff body carries the REASON");

    const record = JSON.parse(readIf(path.join(runDirOf(target), "efficiency-dispatch.jsonl")).trim());
    check(record.state === "applied" && record.rung === "cheap" && record.complexity === "small",
      "the run records the decision as a machine-readable line");
    check(record.builder === "fixture-cheap" && record.builder_pool === "zai" && record.reason !== "",
      "the record carries the backends, their pools and the reason");

    check(/^EFFICIENCY_RUNG=cheap$/m.test(lastRun(target)) && /^BUILDER=fixture-cheap$/m.test(lastRun(target)),
      "last-run.env states the rung the run was dispatched on");
  } finally { cleanup(target); }
}

// ── 2) A different seeded pool state selects a different rung ────────────
console.log("2) the SEEDED ledger/pool state is what moves the dispatch");
{
  // zai is over its 5h cap, so `small` falls through cheap -> mid.
  const capped = makeTarget({
    story: { labels: ["type:feature", "complexity:small"] },
    ledger: [quotaLine({ pool: "zai", window_5h_pct: 99, window_weekly_pct: 99, weekly_reset_at: RESET })],
  });
  // The #28 circuit is the other input: an open zai circuit does the same thing.
  const circuit = makeTarget({ story: { complexity: "small" } });
  try {
    const r = runReview(capped, ["--efficiency"]);
    check(/builder=fixture-mid\s+reviewer=fixture-mid-ro/.test(r.out),
      "a capped zai pool moves the same tier to the next rung (mid)");
    check(/cheap .*skipped/.test(readIf(path.join(runDirOf(capped), "final_status.md"))),
      "the recorded reason says which rung was skipped");
    check(/complexity:small/.test(readIf(path.join(capped, ".agents", "tasks", "prd.json"))),
      "the tier came from a complexity: label rather than a field");

    const c = runReview(circuit, ["--efficiency"],
      { RALPH_QUOTA_OPEN_CIRCUITS: "zai|2099-01-01T00:00:00Z" });
    check(/builder=fixture-mid\s+reviewer=fixture-mid-ro/.test(c.out),
      "an open #28 quota circuit for zai does the same");
  } finally { cleanup(capped); cleanup(circuit); }
}

// ── 3) DEFAULT OFF IS SACRED ─────────────────────────────────────────────
console.log("3) WITHOUT --efficiency dispatch is unchanged (regression guard)");
{
  // Same story, same seeded state that WOULD have moved the dispatch in (2) — the
  // only difference from the control repo is that a profile file exists at all.
  const withProfile = makeTarget({
    story: { complexity: "small" },
    ledger: [quotaLine({ pool: "zai", window_5h_pct: 99, window_weekly_pct: 99, weekly_reset_at: RESET })],
  });
  const withoutProfile = makeTarget({
    profile: null,
    story: { complexity: "small" },
    ledger: [quotaLine({ pool: "zai", window_5h_pct: 99, window_weekly_pct: 99, weekly_reset_at: RESET })],
  });
  try {
    const a = runReview(withProfile);
    const b = runReview(withoutProfile);
    // Normalize the only things that legitimately differ between two runs.
    const norm = (out, target) => out
      .split(target).join("<TARGET>")
      .split(path.basename(wtBase(target))).join("<WT>")
      .split(path.basename(target)).join("<NAME>")
      .replace(/\d{8}-\d{6}-\d+/g, "<RUN_ID>")
      .replace(/\b[0-9a-f]{7,40}\b/g, "<SHA>");
    check(norm(a.out, withProfile) === norm(b.out, withoutProfile),
      "stdout+stderr is byte-for-byte identical with and without the profile present");
    check(a.status === 0 && a.status === b.status, "both runs reach the same exit status");
    check(!/efficiency/i.test(a.out), "not one word about efficiency is printed");
    check(/builder=default-build\s+reviewer=default-review/.test(a.out),
      "--builder/--reviewer still decide who runs");

    const cfg = readIf(path.join(runDirOf(withProfile), "config.resolved.env"));
    check(/^BUILDER=default-build\b/m.test(cfg) && !/EFFICIENCY/.test(cfg),
      "the resolved-config snapshot is the default one, with no efficiency line");
    check(!/efficiency/i.test(readIf(path.join(runDirOf(withProfile), "final_status.md"))),
      "the PR/handoff body says nothing about efficiency");
    check(!existsSync(path.join(runDirOf(withProfile), "efficiency-dispatch.jsonl")),
      "no efficiency record is written");
    check(!/EFFICIENCY/.test(lastRun(withProfile)), "last-run.env gains no efficiency fields");
  } finally { cleanup(withProfile); cleanup(withoutProfile); }
}

// ── 4) Inert fallbacks under the opt-in: bad profile, missing profile, no tier ──
console.log("4) with --efficiency on, anything unusable is INERT + loud, never fatal");
{
  const broken = makeTarget({ profile: "{ not json", story: { complexity: "small" } });
  const missing = makeTarget({ profile: null, story: { complexity: "small" } });
  const untiered = makeTarget({ story: {} });
  try {
    const b = runReview(broken, ["--efficiency"]);
    check(b.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(b.out), "a malformed profile never crashes the run");
    check(/REJECTED efficiency profile/.test(b.out), "the rejection is loud");
    check(/builder=default-build\s+reviewer=default-review/.test(b.out),
      "a malformed profile falls back to the normal --builder/--reviewer dispatch");
    check(/efficiency mode is ON but the profile is rejected/.test(b.out),
      "the fallback says which ticket it applied to and why");
    check(/^EFFICIENCY_STATE=inert$/m.test(lastRun(broken)) && /^EFFICIENCY_RUNG=''$/m.test(lastRun(broken)),
      "the run is recorded as inert, with no rung invented for it");

    const m = runReview(missing, ["--efficiency"]);
    check(m.status === 0 && /builder=default-build\s+reviewer=default-review/.test(m.out),
      "a missing profile is inert too");
    check(/not configured/.test(m.out), "a missing profile says so plainly");

    const u = runReview(untiered, ["--efficiency"]);
    check(u.status === 0 && /builder=default-build\s+reviewer=default-review/.test(u.out),
      "a story with no complexity:<tier> keeps the operator's own selection");
    check(/carries no complexity:<tier> label\/field/.test(u.out),
      "and says loudly that it could not right-size it");
    const rec = JSON.parse(readIf(path.join(runDirOf(untiered), "efficiency-dispatch.jsonl")).trim());
    check(rec.state === "no-complexity" && rec.rung === "",
      "the inert decision is recorded without inventing a rung");
  } finally { cleanup(broken); cleanup(missing); cleanup(untiered); }
}

// ── 5) Bounded PAUSE -> clean pause with its own terminal status ─────────
console.log("5) a bounded PAUSE pauses cleanly (distinct status, artifacts preserved)");
{
  const target = makeTarget({ story: { complexity: "large" } });
  try {
    // tier large = [strong, backstop]; take both pools out via the #28 circuit.
    const r = runReview(target, ["--efficiency"],
      { RALPH_QUOTA_OPEN_CIRCUITS: "anthropic|2099-01-01T00:00:00Z\ndeepseek|2099-01-01T00:00:00Z" });
    check(r.status === 5, "the pause has its own exit code (5), not a crash and not a failure");
    check(/EFFICIENCY_PAUSED/.test(r.out), "the terminal status is EFFICIENCY_PAUSED");
    check(/bounded PAUSE: retry in \d+s/.test(r.out), "the published reason carries the bounded retry");
    check(/^STATUS=EFFICIENCY_PAUSED$/m.test(lastRun(target)),
      "last-run.env records the pause for status/integrate/cleanup");
    check(/^EFFICIENCY_PAUSE_UNTIL='?20\d\d-/m.test(lastRun(target)), "last-run.env carries the retry instant");

    const runDir = runDirOf(target);
    check(existsSync(path.join(runDir, "efficiency-pause.md")), "the pause report is preserved in the run dir");
    check(/Retry after: 20\d\d-/.test(readIf(path.join(runDir, "efficiency-pause.md"))),
      "the pause report states when to retry");
    const rec = JSON.parse(readIf(path.join(runDir, "efficiency-dispatch.jsonl")).trim());
    check(rec.state === "paused" && rec.pause_until !== "", "the paused decision is recorded");

    check(!existsSync(wtBase(target)) || readdirSync(wtBase(target)).length === 0,
      "no worktree was created for a paused run");
    check(!/ralph\//.test(git(target, ["branch", "--list", "ralph/*"])), "no branch was created either");
    check(git(target, ["status", "--porcelain"]) === "", "the target repo is left clean");
  } finally { cleanup(target); }
}

// ── 6) batch: the rung is chosen PER TASK and never leaks to the next ────
console.log("6) batch: per-task rungs, recorded in the result file and the ledger");
{
  const target = makeTarget({ story: {} });
  // Plans live outside the target repo (otherwise they make it dirty).
  const plan = mkdtempSync(path.join(tmpdir(), "ralph-eff-plan-"));
  writeFileSync(path.join(target, "ralph.target.json"),
    JSON.stringify({ check: "true", preview: { enabled: false } }, null, 2));
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "target config"]);
  writeFileSync(path.join(plan, "01-easy.md"), "# Easy task\ncomplexity:trivial\n\nDo the easy thing.\n");
  writeFileSync(path.join(plan, "02-hard.md"), "# Hard task\nComplexity: large\n\nDo the hard thing.\n");
  writeFileSync(path.join(plan, "03-unsized.md"), "# Unsized task\n\nNobody sized this one.\n");
  try {
    const r = spawnSync(process.execPath, [cliPath, "batch", "--repo", target, "--plan", plan,
      "--builder", "default-build", "--reviewer", "default-review", "--efficiency"],
    { encoding: "utf-8", env: cleanEnv({ RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target) }) });
    const out = `${r.stdout}${r.stderr}`;
    const runDir = (() => {
      const base = path.join(target, ".agent-run");
      const dirs = readdirSync(base).filter((d) => d.startsWith("batch-")).sort();
      return path.join(base, dirs[dirs.length - 1]);
    })();
    check(r.status === 0, "the batch completes");
    const t1 = readIf(path.join(runDir, "task-001-result.md"));
    const t2 = readIf(path.join(runDir, "task-002-result.md"));
    const t3 = readIf(path.join(runDir, "task-003-result.md"));
    check(/builder: fixture-backstop /.test(t1) && /efficiency: rung backstop \(complexity trivial\)/.test(t1),
      "task 1 (complexity:trivial) is dispatched on the trivial tier's first rung");
    check(/builder: fixture-strong /.test(t2) && /efficiency: rung strong \(complexity large\)/.test(t2),
      "task 2 (Complexity: large) gets its OWN rung — the previous one did not stick");
    check(/builder: default-build /.test(t3) && /efficiency: no-complexity/.test(t3),
      "an unsized task falls back to the operator's selection, undoing the previous rung");

    const ledger = readIf(path.join(target, ".ralph", "ledger.jsonl")).trim().split("\n")
      .map((l) => JSON.parse(l));
    check(ledger[0].efficiency && ledger[0].efficiency.rung === "backstop"
      && ledger[0].efficiency.complexity === "trivial" && ledger[0].efficiency.reason !== "",
      "the ledger record for task 1 carries the rung, tier and reason");
    check(ledger[1].efficiency && ledger[1].efficiency.rung === "strong",
      "the ledger record for task 2 carries its own rung");
    check(ledger[2].efficiency && ledger[2].efficiency.state === "no-complexity"
      && ledger[2].efficiency.rung === "",
      "the unsized task is recorded as inert without a fabricated rung");

    const records = readIf(path.join(runDir, "efficiency-dispatch.jsonl")).trim().split("\n")
      .map((l) => JSON.parse(l));
    check(records.length === 3 && records.map((x) => x.state).join(",") === "applied,applied,no-complexity",
      "every task's decision is recorded in the run");
    check(/efficiency: rung backstop/.test(out) && /efficiency: rung strong/.test(out),
      "each task announces its rung as it is dispatched");
  } finally {
    rmSync(plan, { recursive: true, force: true });
    cleanup(target);
  }
}

// ── 7) batch: default OFF, and a PAUSE stops the batch cleanly ───────────
console.log("7) batch: default OFF unchanged; a PAUSE stops the batch cleanly");
{
  const mkBatchTarget = () => {
    const t = makeTarget({ story: {} });
    writeFileSync(path.join(t, "ralph.target.json"),
      JSON.stringify({ check: "true", preview: { enabled: false } }, null, 2));
    git(t, ["add", "-A"]);
    git(t, ["commit", "-q", "-m", "target config"]);
    return t;
  };
  const off = mkBatchTarget();
  const paused = mkBatchTarget();
  const plan = mkdtempSync(path.join(tmpdir(), "ralph-eff-plan2-"));
  writeFileSync(path.join(plan, "01-easy.md"), "# Easy task\ncomplexity:trivial\n\nDo the easy thing.\n");
  writeFileSync(path.join(plan, "02-hard.md"), "# Hard task\ncomplexity:large\n\nDo the hard thing.\n");
  const runBatch = (t, extraArgs, env = {}) => {
    const r = spawnSync(process.execPath, [cliPath, "batch", "--repo", t, "--plan", plan,
      "--builder", "default-build", "--reviewer", "default-review", ...extraArgs],
    { encoding: "utf-8", env: cleanEnv({ RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(t), ...env }) });
    const base = path.join(t, ".agent-run");
    const dirs = readdirSync(base).filter((d) => d.startsWith("batch-")).sort();
    return { ...r, out: `${r.stdout}${r.stderr}`, runDir: path.join(base, dirs[dirs.length - 1]) };
  };
  try {
    const o = runBatch(off, []);
    check(o.status === 0 && !/efficiency/i.test(o.out),
      "without --efficiency the batch prints nothing about efficiency");
    check(/builder: default-build /.test(readIf(path.join(o.runDir, "task-001-result.md"))),
      "and every task is dispatched on the operator's selection");
    const offLedger = readIf(path.join(off, ".ralph", "ledger.jsonl")).trim().split("\n")
      .map((l) => JSON.parse(l));
    check(offLedger.every((rec) => !("efficiency" in rec)),
      "the ledger record keeps exactly the shape it has today (no efficiency key)");

    // Task 1 (trivial) dispatches on the backstop; task 2 (large) finds nothing.
    const p = runBatch(paused, ["--efficiency"],
      { RALPH_QUOTA_OPEN_CIRCUITS: "anthropic|2099-01-01T00:00:00Z\ndeepseek|2099-01-01T00:00:00Z" });
    check(p.status === 5, "the batch exits 5 on a bounded pause");
    check(/EFFICIENCY_PAUSED/.test(p.out), "with EFFICIENCY_PAUSED as the terminal status");
    check(/^STATUS=EFFICIENCY_PAUSED$/m.test(lastRun(paused)), "last-run.env records it for --resume");
    const report = readIf(path.join(p.runDir, "final-report.md"));
    check(/## ⏸ Efficiency pause/.test(report) && /Paused before dispatching task 002/.test(report),
      "the report names the task that was not dispatched");
    check(/attempted: 1 of 2 \(completed: 1/.test(report),
      "the paused task is not counted as attempted");
    check(existsSync(path.join(p.runDir, "task-001-result.md"))
      && !existsSync(path.join(p.runDir, "task-002-result.md")),
      "the completed task's artifacts are preserved; the paused one has none");
    const pausedLedger = readIf(path.join(paused, ".ralph", "ledger.jsonl")).trim().split("\n");
    // Task 1 is `trivial` = [backstop, cheap]; deepseek is circuit-broken here too, so
    // it legitimately lands on `cheap` — the same state that leaves `large` with nothing.
    check(pausedLedger.length === 1 && JSON.parse(pausedLedger[0]).efficiency.rung === "cheap",
      "the completed task's usage line is flushed to the ledger before the pause");
  } finally {
    rmSync(plan, { recursive: true, force: true });
    cleanup(off); cleanup(paused);
  }
}

console.log(`\nefficiency-dispatch: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
