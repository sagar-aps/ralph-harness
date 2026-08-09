// Tests for #64 — auto-escalate: a rung that burns its iteration budget without a
// PASS is PROMOTED to the next stronger eligible rung and retried with a fresh
// budget, carrying the reviewer's must-fix feedback forward.
//
// Three properties are pinned here, and they are the whole slice:
//   1. fail -> escalate -> pass. The per-rung budget (not MAX_ITERATIONS) governs,
//      the promotion respects #61 eligibility, and the feedback survives the move.
//   2. DEFAULT OFF is sacred. Without --auto-escalate a spent budget is still
//      FAILED_MAX_ITERATIONS, and the no-op path (flag on, no rung ladder) changes
//      nothing but the one warning line it prints.
//   3. BOUNDED. Escalation stops at the strongest eligible rung / the backstop and
//      then ends on a terminal status naming every rung tried — never a loop.
//
// No real agents run: the "backends" are fixture shell scripts on PATH whose
// verdict is decided by the fixture, so a rung failing or passing is an input.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync }
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

// Sunday 2026-08-09 12:00 UTC — the fixture profile has no avoid windows and no
// weekly anchor, so nothing here depends on the wall clock.
const NOW = "2026-08-09T12:00:00Z";

// Backends named so nothing in the harness can special-case them (no "claude"/
// "codex" substring => no usage-JSON flag rewriting, no codex sandbox handling).
const RUNG_BACKENDS = ["fixture-cheap", "fixture-mid", "fixture-strong", "fixture-backstop"];
const BACKEND_ENV = {
  AGENT_FIXTURE_CHEAP_CMD: "fixture-cheap-bin {prompt}",
  AGENT_FIXTURE_MID_CMD: "fixture-mid-bin {prompt}",
  AGENT_FIXTURE_STRONG_CMD: "fixture-strong-bin {prompt}",
  AGENT_FIXTURE_BACKSTOP_CMD: "fixture-backstop-bin {prompt}",
  AGENT_DEFAULT_BUILD_CMD: "default-build-bin {prompt}",
  AGENT_DEFAULT_REVIEW_CMD: "default-review-bin {prompt}",
};

// A four-rung ladder, one pool per rung, so a seeded pool state maps 1:1 to a rung.
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
      reviewer: { backend: "fixture-mid", pool: "openai" },
      caps: { openai: { source: "provider" } },
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
  reserves: { manager_pct: 25, orchestrator_pct: 50, near_weekly_reset_hours: 5 },
  tiers: {
    trivial: ["cheap"],
    small: ["cheap", "mid"],
    medium: ["cheap", "mid", "strong"],
    large: ["strong"],
  },
};

// ── Fixture backends ──────────────────────────────────────────────────────
// One script per backend. `passing` decides the verdict it writes, so "rung X
// fails, rung Y passes" is a fixture input rather than a real model's behaviour.
// The script also does what a builder does (writes a handoff, touches a file) so
// the loop sees a real diff.
const MUST_FIX = "carry-me-forward: the widget must handle the empty case";

function makeBins(passing) {
  const binDir = mkdtempSync(path.join(tmpdir(), "ralph-esc-bin-"));
  const script = (name, verdict) => `#!/usr/bin/env bash
set -eu
echo "${name} ran with prompt $1" >> "$RALPH_FIXTURE_LOG"
printf '# handoff from ${name}\\n' > .agent-handoff.md
printf '%s\\n' "${name}" >> fixture-work.txt
echo "### Must-fix issues"
echo "- ${MUST_FIX} (${name})"
echo ""
echo "VERDICT: ${verdict}"
`;
  for (const backend of [...RUNG_BACKENDS, "default-build", "default-review"]) {
    const file = path.join(binDir, `${backend}-bin`);
    writeFileSync(file, script(backend, passing.includes(backend) ? "PASS" : "FAIL"));
    chmodSync(file, 0o755);
  }
  return binDir;
}

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeTarget({ profile = PROFILE, story = {} } = {}) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-esc-"));
  mkdirSync(path.join(target, ".agents", "ralph"), { recursive: true });
  mkdirSync(path.join(target, ".agents", "tasks"), { recursive: true });
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  if (profile !== null) {
    writeFileSync(path.join(target, ".agents", "ralph", "efficiency.json"),
      JSON.stringify(profile, null, 2));
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
function cleanup(...targets) {
  for (const target of targets) {
    rmSync(wtBase(target), { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

function runReview(target, binDir, extraArgs = [], env = {}) {
  const fixtureLog = path.join(binDir, "calls.log");
  const r = spawnSync(process.execPath, [cliPath, "review", "1", "--repo", target,
    "--builder", "default-build", "--reviewer", "default-review",
    "--check", "true", ...extraArgs],
  {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RALPH_SKIP_UPDATE_CHECK: "1",
      RALPH_NO_LOCAL_CONFIG: "1",
      RALPH_FIXTURE_LOG: fixtureLog,
      RALPH_EFFICIENCY_NOW: NOW,
      RALPH_WORKTREE_DIR: wtBase(target),
      // Scrub anything an outer ralph run exported, so only the fixture decides.
      TARGET_REPO: "", PRD_PATH: "", TASK_ID: "", TASK_INDEX: "", BRANCH: "",
      BUILDER: "", REVIEWER: "", RALPH_PROFILE: "", PREVIEW_ENABLED: "",
      BUILDER_PROVIDER: "", BUILDER_MODEL: "", REVIEWER_PROVIDER: "", REVIEWER_MODEL: "",
      RALPH_EFFICIENCY: "", RALPH_EFFICIENCY_PROFILE: "", RALPH_AUTO_ESCALATE: "",
      RALPH_ESCALATE_ITERATIONS: "", RALPH_EFFICIENCY_DISPATCH_STATE: "",
      RALPH_QUOTA_OPEN_CIRCUITS: "", RALPH_CRON_DRIVER: "", RALPH_CRON_DRIVER_DEFAULT: "",
      RALPH_CRON_DRIVER_PROVIDER: "", RALPH_CRON_DRIVER_MODEL: "",
      RALPH_CRON_DRIVER_EFFORT: "", RALPH_MANAGER_POOL: "",
      ...BACKEND_ENV,
      ...env,
    },
  });
  return { ...r, out: `${r.stdout}${r.stderr}` };
}

const runDirOf = (target) => {
  const runs = path.join(target, ".ralph", "runs");
  const dirs = readdirSync(runs).sort();
  return path.join(runs, dirs[dirs.length - 1]);
};
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf-8") : "");
const lastRun = (target) => readIf(path.join(target, ".ralph", "last-run.env"));
const jsonl = (p) => readIf(p).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const builderRuns = (target) =>
  readdirSync(runDirOf(target)).filter((f) => /^builder_output_\d+\.log$/.test(f)).length;

// ── 1) fail -> escalate -> pass ───────────────────────────────────────────
console.log("1) --auto-escalate: a spent budget promotes to the next stronger rung");
{
  // `cheap` always fails, `mid` passes: the story can only complete by escalating.
  const bins = makeBins(["fixture-mid"]);
  const target = makeTarget({ story: { complexity: "small" } });
  try {
    const r = runReview(target, bins, ["--efficiency", "--auto-escalate",
      "--escalate-iterations", "2", "--max-iterations", "1"]);
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out),
      "the run completes normally once a rung passes");
    check(/escalated: cheap -> mid/.test(r.out), "the promotion is announced (cheap -> mid)");
    check(/Rung cheap spent its 2-iteration budget/.test(r.out),
      "the PER-RUNG budget governs, not --max-iterations (1 here)");
    check(builderRuns(target) === 3,
      "2 iterations were spent on cheap, then 1 on mid (3 builder runs)");

    // The point of escalating is that the stronger builder inherits the work.
    const prompt3 = readIf(path.join(runDirOf(target), "builder_prompt_3.md"));
    check(prompt3.includes(MUST_FIX) && /fixture-cheap/.test(prompt3),
      "the first rung's must-fix feedback is carried forward into the new rung's builder");

    const escalations = jsonl(path.join(runDirOf(target), "escalations.jsonl"));
    check(escalations.length === 1 && escalations[0].from_rung === "cheap"
      && escalations[0].to_rung === "mid" && escalations[0].reason !== "",
      "the run records the escalation (from -> to, reason)");
    check(escalations[0].after_iteration === "2" && escalations[0].complexity === "small",
      "the record says which iteration it happened after, and for which tier");

    const ledger = jsonl(path.join(target, ".ralph", "ledger.jsonl"))
      .filter((rec) => rec.event === "efficiency_escalation");
    check(ledger.length === 1 && ledger[0].to_rung === "mid" && ledger[0].run_id !== "",
      "the escalation is also durable in the ledger, tagged with its run");

    const status = readIf(path.join(runDirOf(target), "final_status.md"));
    check(/- Rungs tried: cheap -> mid \(1 escalation\(s\)\)/.test(status),
      "the PR/handoff body names the rungs tried, in order");
    check(/- Builder backend: fixture-mid /.test(status)
      && /efficiency: rung mid \(complexity small\)/.test(status),
      "and attributes the run to the rung it finished on");

    check(/^ESCALATION_COUNT=1$/m.test(lastRun(target))
      && /^ESCALATION_RUNGS=cheap\\ -\\>\\ mid$/m.test(lastRun(target)),
      "last-run.env carries the escalation trail");
    check(/^BUILDER=fixture-mid$/m.test(lastRun(target)),
      "and the backend the run ended on");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true }); }
}

// ── 2) a PASS on the first rung never escalates ───────────────────────────
console.log("2) a PASS at the starting rung completes normally, with no promotion");
{
  const bins = makeBins(["fixture-cheap"]);
  const target = makeTarget({ story: { complexity: "small" } });
  try {
    const r = runReview(target, bins, ["--efficiency", "--auto-escalate"]);
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out), "the run passes");
    check(builderRuns(target) === 1, "on the first iteration of the first rung");
    check(!/escalated:/.test(r.out), "nothing is escalated");
    check(!existsSync(path.join(runDirOf(target), "escalations.jsonl")),
      "and no escalation record is written");
    check(/- Rungs tried: cheap \(0 escalation\(s\)\)/.test(
      readIf(path.join(runDirOf(target), "final_status.md"))),
      "the PR/handoff body still states which rung did the work");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true }); }
}

// ── 3) escalation obeys #61 eligibility (composes with efficiency mode) ────
console.log("3) the promotion skips an INELIGIBLE rung (caps/circuits/reserves still bind)");
{
  const bins = makeBins(["fixture-strong"]);
  const target = makeTarget({ story: { complexity: "medium" } });
  try {
    // medium = [cheap, mid, strong]; an open #28 circuit on openai takes `mid` out,
    // so the promotion from cheap has to jump it.
    const r = runReview(target, bins, ["--efficiency", "--auto-escalate",
      "--escalate-iterations", "1"], { RALPH_QUOTA_OPEN_CIRCUITS: "openai|2099-01-01T00:00:00Z" });
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out), "the run completes");
    check(/escalated: cheap -> strong/.test(r.out), "cheap is promoted straight to strong");
    check(/first eligible rung above 'cheap' in tier 'medium' — mid was skipped/.test(
      readIf(path.join(runDirOf(target), "final_status.md"))),
      "the recorded reason says the ineligible rung was skipped over");
    check(builderRuns(target) === 2, "one iteration per rung, and mid never ran");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true }); }
}

// ── 4) BOUNDED: the ladder runs out and the run stops for good ────────────
console.log("4) bounded — exhausting the ladder ends on a terminal status naming the rungs");
{
  const bins = makeBins([]); // nothing ever passes
  const target = makeTarget({ story: { complexity: "medium" } });
  try {
    const r = runReview(target, bins, ["--efficiency", "--auto-escalate",
      "--escalate-iterations", "1"]);
    check(r.status === 2, "the run fails (exit 2), like any other failed review");
    check(/FAILED_ESCALATION_EXHAUSTED/.test(r.out) && !/FAILED_MAX_ITERATIONS/.test(r.out),
      "with its own terminal status, distinct from FAILED_MAX_ITERATIONS");
    check(/rungs tried: cheap -> mid -> strong -> backstop \(all failed\)/.test(r.out),
      "the banner names every rung it tried, in order");
    check(/the ladder is EXHAUSTED/.test(r.out), "and says the ladder ran out");
    check(builderRuns(target) === 4,
      "exactly 4 iterations ran (one per rung) — the loop is bounded, never infinite");
    check(jsonl(path.join(runDirOf(target), "escalations.jsonl")).map((e) => e.to_rung).join(",")
      === "mid,strong,backstop", "every promotion is recorded, up to the backstop");
    check(/^STATUS=FAILED_ESCALATION_EXHAUSTED$/m.test(lastRun(target)),
      "last-run.env records the terminal status for status/cleanup");
    check(/- Escalation stopped: cannot promote above rung 'backstop'/.test(
      readIf(path.join(runDirOf(target), "final_status.md"))),
      "the PR/handoff body explains why no further promotion was possible");

    // The escalation events must not corrupt the usage report they share a file with.
    const report = spawnSync(process.execPath, [cliPath, "report", "--repo", target],
      { encoding: "utf-8", env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1" } });
    check(!/unknown/.test(`${report.stdout}`),
      "`ralph report` ignores the escalation events instead of inventing an unknown ticket");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true }); }
}

// ── 5) DEFAULT OFF IS SACRED ──────────────────────────────────────────────
console.log("5) WITHOUT --auto-escalate a spent budget is still FAILED_MAX_ITERATIONS");
{
  const bins = makeBins([]);
  const target = makeTarget({ story: { complexity: "small" } });
  const falsy = makeTarget({ story: { complexity: "small" } });
  try {
    const r = runReview(target, bins, ["--efficiency", "--max-iterations", "2"]);
    check(r.status === 2 && /FAILED_MAX_ITERATIONS/.test(r.out),
      "the run ends on today's terminal status");
    check(builderRuns(target) === 2, "after exactly MAX_ITERATIONS iterations");
    check(/── Iteration 1 of 2 ─/.test(r.out) && /── Iteration 2 of 2 ─/.test(r.out),
      "the iteration banner is the one it has always printed");
    check(!/escalat/i.test(r.out), "not one word about escalation is printed");
    check(/- Iterations run: 2 of 2/.test(readIf(path.join(runDirOf(target), "final_status.md")))
      && !/Rungs tried/.test(readIf(path.join(runDirOf(target), "final_status.md"))),
      "the PR/handoff body is the default one");
    check(!existsSync(path.join(runDirOf(target), "escalations.jsonl")),
      "no escalation artifact is written");
    check(!/ESCALAT/.test(lastRun(target)), "last-run.env gains no escalation fields");
    check(jsonl(path.join(target, ".ralph", "ledger.jsonl")).length === 0
      || !existsSync(path.join(target, ".ralph", "ledger.jsonl")),
      "and nothing is appended to the ledger");

    // A falsy RALPH_AUTO_ESCALATE must be as inert as an unset one.
    const f = runReview(falsy, bins, ["--efficiency", "--max-iterations", "2"],
      { RALPH_AUTO_ESCALATE: "0" });
    const norm = (out, t) => out
      .split(t).join("<TARGET>")
      .split(path.basename(wtBase(t))).join("<WT>")
      .split(path.basename(t)).join("<NAME>")
      .replace(/\d{8}-\d{6}-\d+/g, "<RUN_ID>")
      .replace(/\b[0-9a-f]{7,40}\b/g, "<SHA>");
    check(norm(f.out, falsy) === norm(r.out, target),
      "RALPH_AUTO_ESCALATE=0 is byte-for-byte the unset run");
  } finally { cleanup(target, falsy); rmSync(bins, { recursive: true, force: true }); }
}

// ── 6) degrades gracefully when there is no rung ladder ───────────────────
console.log("6) with no efficiency ladder, --auto-escalate is a NO-OP with a note");
{
  const bins = makeBins([]);
  // No profile at all, and no --efficiency: there is no rung to promote off.
  const flagged = makeTarget({ profile: null, story: { complexity: "small" } });
  const plain = makeTarget({ profile: null, story: { complexity: "small" } });
  try {
    const a = runReview(flagged, bins, ["--auto-escalate", "--max-iterations", "2"]);
    const b = runReview(plain, bins, ["--max-iterations", "2"]);
    check(a.status === 2 && /FAILED_MAX_ITERATIONS/.test(a.out),
      "the run degrades to today's behavior");
    check(/--auto-escalate needs the efficiency rung ladder/.test(a.out),
      "and says loudly that it had nothing to escalate on");

    const norm = (out, t) => out
      .split(t).join("<TARGET>")
      .split(path.basename(wtBase(t))).join("<WT>")
      .split(path.basename(t)).join("<NAME>")
      .replace(/\d{8}-\d{6}-\d+/g, "<RUN_ID>")
      .replace(/\b[0-9a-f]{7,40}\b/g, "<SHA>");
    const withoutNote = norm(a.out, flagged)
      .split("\n").filter((line) => !line.includes("--auto-escalate needs")).join("\n");
    check(withoutNote === norm(b.out, plain),
      "the note is the ONLY difference the no-op makes to the run");

    // A story with no complexity tier has no rung either, even under --efficiency.
    const untiered = makeTarget({ story: {} });
    try {
      const u = runReview(untiered, bins, ["--efficiency", "--auto-escalate",
        "--max-iterations", "1"]);
      check(u.status === 2 && /FAILED_MAX_ITERATIONS/.test(u.out),
        "an unsized story under --efficiency degrades the same way");
      check(/--auto-escalate needs the efficiency rung ladder/.test(u.out),
        "with the same note");
    } finally { cleanup(untiered); }
  } finally { cleanup(flagged, plain); rmSync(bins, { recursive: true, force: true }); }
}

// ── 7) a bad --escalate-iterations is corrected, never fatal ──────────────
console.log("7) an invalid per-rung budget warns and falls back to the default of 3");
{
  const bins = makeBins(["fixture-mid"]);
  const target = makeTarget({ story: { complexity: "small" } });
  try {
    const r = runReview(target, bins, ["--efficiency", "--auto-escalate",
      "--escalate-iterations", "zero"]);
    check(/must be a positive integer .*using 3/.test(r.out), "the bad value is called out");
    check(/with 3 iteration\(s\) per rung/.test(r.out), "and the documented default is used");
    check(r.status === 0 && builderRuns(target) === 4,
      "the run still completes: 3 failed iterations on cheap, then mid passes");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true }); }
}

console.log(`\nauto-escalate: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
