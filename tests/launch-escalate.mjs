// Tests for #75 — LAUNCH-failure escalation in `ralph batch`.
//
// A backend that never RAN (non-zero/backend-unavailable ERROR after the harness
// retries, or an executable that is not installed) is not a verdict: nothing was
// built and nothing was reviewed, so #64's review-failure escalation cannot see it.
// Before this, one unlaunchable backend halted the WHOLE batch even when the
// efficiency ladder still had healthy stronger rungs.
//
// Four properties are pinned here, and they are the whole slice:
//   1. Under --efficiency a launch failure (builder OR reviewer) promotes the task to
//      the next stronger ELIGIBLE rung and retries there; a launchable rung finishes
//      the task normally. Each promotion is recorded in the run, the ledger and the
//      per-task PR body.
//   2. A rung the machine cannot even BIND (backend not installed) is the same kind of
//      launch failure and is climbed past, not died on.
//   3. BOUNDED: escalation walks the ladder up to the backstop and then halts on its
//      own terminal status naming every rung tried — one launch per rung, never a loop.
//   4. WITHOUT --efficiency there is no ladder, so the existing BUILDER_UNAVAILABLE
//      halt is byte-for-byte what it is today.
//
// No real agents run: the "backends" are fixture shell scripts on PATH, so "this rung
// cannot launch" is a fixture input rather than a real outage.
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
// `fixture-ghost` is deliberately NEVER written to the bin dir: it is the
// "rung names a backend this machine does not have" case.
const BACKENDS = ["fixture-cheap", "fixture-cheap-ro", "fixture-mid", "fixture-strong",
  "fixture-backstop", "default-build", "default-review"];
const BACKEND_ENV = {
  AGENT_FIXTURE_CHEAP_CMD: "fixture-cheap-bin {prompt}",
  AGENT_FIXTURE_CHEAP_RO_CMD: "fixture-cheap-ro-bin {prompt}",
  AGENT_FIXTURE_MID_CMD: "fixture-mid-bin {prompt}",
  AGENT_FIXTURE_STRONG_CMD: "fixture-strong-bin {prompt}",
  AGENT_FIXTURE_BACKSTOP_CMD: "fixture-backstop-bin {prompt}",
  AGENT_FIXTURE_GHOST_CMD: "fixture-ghost-bin {prompt}",
  AGENT_DEFAULT_BUILD_CMD: "default-build-bin {prompt}",
  AGENT_DEFAULT_REVIEW_CMD: "default-review-bin {prompt}",
};

// A four-rung ladder, one pool per rung, so a seeded pool state maps 1:1 to a rung.
// `cheap` has a SEPARATE reviewer backend so a reviewer-only launch failure is
// expressible; `ghostly` is the tier used for the not-installed case.
const profileWith = (cheapBuilder = "fixture-cheap") => ({
  rungs: [
    {
      name: "cheap",
      builder: { backend: cheapBuilder, pool: "zai" },
      reviewer: { backend: "fixture-cheap-ro", pool: "zai" },
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
});
const PROFILE = profileWith();

// ── Fixture backends ──────────────────────────────────────────────────────
// A backend in `launchFails` exits non-zero without writing anything — exactly what a
// logged-out CLI, a wrong binary path or an auth error looks like to the harness. Any
// other backend behaves like a working agent: it edits a file, writes a handoff, and
// (as reviewer) prints a PASS verdict.
function makeBins(launchFails = [], omit = []) {
  const binDir = mkdtempSync(path.join(tmpdir(), "ralph-launch-bin-"));
  const working = (name) => `#!/usr/bin/env bash
set -eu
echo "${name} ran with prompt $1" >> "$RALPH_FIXTURE_LOG"
printf '# handoff from ${name}\\n' > .agent-handoff.md
printf '%s\\n' "${name}" >> fixture-work.txt
echo "### Must-fix issues"
echo "- none"
echo ""
echo "VERDICT: PASS"
`;
  const unlaunchable = (name) => `#!/usr/bin/env bash
echo "${name}: backend unavailable (fixture)" >&2
exit 1
`;
  for (const backend of BACKENDS) {
    if (omit.includes(backend)) continue;          // not installed on this machine
    const file = path.join(binDir, `${backend}-bin`);
    writeFileSync(file, launchFails.includes(backend) ? unlaunchable(backend) : working(backend));
    chmodSync(file, 0o755);
  }
  return binDir;
}

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeTarget({ profile = PROFILE } = {}) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-launch-"));
  mkdirSync(path.join(target, ".agents", "ralph"), { recursive: true });
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  if (profile !== null) {
    writeFileSync(path.join(target, ".agents", "ralph", "efficiency.json"),
      JSON.stringify(profile, null, 2));
  }
  writeFileSync(path.join(target, "ralph.target.json"),
    JSON.stringify({ check: "true", preview: { enabled: false } }, null, 2));
  writeFileSync(path.join(target, "README.md"), "# Target\n");
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  return target;
}

// Plans live OUTSIDE the target repo, or they would make it dirty.
function makePlan(body = "# A task\ncomplexity:small\n\nDo the thing.\n") {
  const plan = mkdtempSync(path.join(tmpdir(), "ralph-launch-plan-"));
  writeFileSync(path.join(plan, "01-task.md"), body);
  return plan;
}

const wtBase = (target) => path.join(target, "..", `ralph-launch-wt-${path.basename(target)}`);
function cleanup(...targets) {
  for (const target of targets) {
    rmSync(wtBase(target), { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

function runBatch(target, binDir, plan, extraArgs = [], env = {}) {
  const r = spawnSync(process.execPath, [cliPath, "batch", "--repo", target, "--plan", plan,
    "--builder", "default-build", "--reviewer", "default-review",
    "--check", "true", "--max-iterations", "1", ...extraArgs],
  {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RALPH_SKIP_UPDATE_CHECK: "1",
      RALPH_NO_LOCAL_CONFIG: "1",
      RALPH_FIXTURE_LOG: path.join(binDir, "calls.log"),
      RALPH_EFFICIENCY_NOW: NOW,
      RALPH_WORKTREE_DIR: wtBase(target),
      // One launch per rung, no backoff sleeps: the retry-the-same-backend behaviour
      // is #28/#47 territory and already tested; this suite is about the promotion.
      RALPH_AGENT_RETRIES: "0",
      RALPH_SNAPSHOT_INTERVAL: "0",
      // Scrub anything an outer ralph run exported, so only the fixture decides.
      TARGET_REPO: "", PLAN: "", PRD_PATH: "", TASK_ID: "", TASK_INDEX: "", BRANCH: "",
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
  const base = path.join(target, ".agent-run");
  const dirs = existsSync(base)
    ? readdirSync(base).filter((d) => d.startsWith("batch-")).sort() : [];
  return {
    ...r,
    out: `${r.stdout}${r.stderr}`,
    runDir: dirs.length ? path.join(base, dirs[dirs.length - 1]) : "",
  };
}

const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf-8") : "");
const lastRun = (target) => readIf(path.join(target, ".ralph", "last-run.env"));
const jsonl = (p) => readIf(p).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const builderLaunches = (runDir) =>
  readdirSync(runDir).filter((f) => /^task-001-iter-1-builder(-rung-[a-z]+)?\.log$/.test(f)).length;

// ── 1) builder launch failure -> escalate -> the next rung finishes the task ──
console.log("1) --efficiency: a builder that cannot LAUNCH promotes the task to the next rung");
{
  const bins = makeBins(["fixture-cheap"]);      // cheap's builder never runs
  const target = makeTarget();
  const plan = makePlan();
  try {
    const r = runBatch(target, bins, plan, ["--efficiency"]);
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out),
      "the batch completes instead of halting on BUILDER_UNAVAILABLE");
    check(!/BUILDER_UNAVAILABLE/.test(r.out), "and never reports the old single-backend halt");
    check(/⚠ builder backend failed to LAUNCH on rung cheap/.test(r.out),
      "the launch failure is named as a launch failure, not a task failure");
    check(/escalated \(launch failure\): cheap -> mid \(builder fixture-mid, reviewer fixture-mid\)/.test(r.out),
      "the promotion is announced with the rung and both new backends");
    check(builderLaunches(r.runDir) === 2,
      "exactly two builder launches: the failed rung, then the stronger one");
    check(/fixture-cheap: backend unavailable/.test(readIf(path.join(r.runDir, "task-001-iter-1-builder.log")))
      && /VERDICT: PASS/.test(readIf(path.join(r.runDir, "task-001-iter-1-builder-rung-mid.log"))),
      "both logs are kept: what failed to launch, and what ran instead");

    const result = readIf(path.join(r.runDir, "task-001-result.md"));
    check(/^- Result: PASS/m.test(result), "the task itself PASSes on the stronger rung");
    check(/- Launch-failure escalation \(#75\): rungs tried cheap -> mid \(1 escalation\(s\); could not launch: builder@cheap/.test(result),
      "the per-task PR body names the rungs tried and which role could not launch");
    check(/builder: fixture-mid /.test(result) && /efficiency: rung mid /.test(result),
      "and attributes the task to the rung it finished on");

    const escalations = jsonl(path.join(r.runDir, "escalations.jsonl"));
    check(escalations.length === 1 && escalations[0].from_rung === "cheap"
      && escalations[0].to_rung === "mid" && escalations[0].reason !== "",
      "the run records the escalation (from -> to, reason)");
    check(escalations[0].trigger === "builder_launch_failure",
      "the record says it was a LAUNCH failure, distinct from #64's iteration_budget");
    check(escalations[0].ticket === "task 001" && escalations[0].complexity === "small",
      "tagged with the task and its tier");

    const ledger = jsonl(path.join(target, ".ralph", "ledger.jsonl"))
      .filter((rec) => rec.event === "efficiency_escalation");
    check(ledger.length === 1 && ledger[0].to_rung === "mid"
      && ledger[0].trigger === "builder_launch_failure" && ledger[0].run_id.startsWith("batch-"),
      "the escalation is durable in the ledger too, tagged with its run");

    check(/^LAUNCH_ESCALATIONS=1$/m.test(lastRun(target))
      && /^LAUNCH_ESCALATION_RUNGS=cheap\\ -\\>\\ mid$/m.test(lastRun(target)),
      "last-run.env carries the launch-escalation trail");
    check(/## ⚙ Launch-failure escalations \(#75\)/.test(readIf(path.join(r.runDir, "final-report.md"))),
      "the final report has its own launch-escalation section");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true }); }
}

// ── 2) the REVIEWER is the role that cannot launch ────────────────────────
console.log("2) a reviewer that cannot LAUNCH escalates the same way");
{
  const bins = makeBins(["fixture-cheap-ro"]);   // cheap BUILDS fine; its reviewer dies
  const target = makeTarget();
  const plan = makePlan();
  try {
    const r = runBatch(target, bins, plan, ["--efficiency"]);
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out),
      "the batch completes instead of halting on REVIEWER_UNAVAILABLE");
    check(/⚠ reviewer backend failed to LAUNCH on rung cheap/.test(r.out)
      && /escalated \(launch failure\): cheap -> mid/.test(r.out),
      "the reviewer launch failure promotes the task to the next rung");
    check(builderLaunches(r.runDir) === 1,
      "the builder is NOT re-run: only the role that failed to launch is retried");
    check(existsSync(path.join(r.runDir, "task-001-iter-1-reviewer-rung-mid.md")),
      "the new rung's reviewer output is its own artifact");
    const result = readIf(path.join(r.runDir, "task-001-result.md"));
    check(/^- Result: PASS/m.test(result) && /- Reviewer verdict: PASS/m.test(result),
      "the stronger rung's reviewer produces the verdict");
    check(/could not launch: reviewer@cheap/.test(result),
      "the PR body says the REVIEWER was the role that could not launch");
    check(jsonl(path.join(r.runDir, "escalations.jsonl"))[0].trigger === "reviewer_launch_failure",
      "and the record distinguishes it from a builder launch failure");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true }); }
}

// ── 3) a rung whose backend is not installed at all ──────────────────────
console.log("3) a rung naming a backend that is not installed is climbed past, not died on");
{
  const bins = makeBins();                        // fixture-ghost-bin is never written
  const target = makeTarget({ profile: profileWith("fixture-ghost") });
  const plan = makePlan();
  try {
    const r = runBatch(target, bins, plan, ["--efficiency"]);
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out),
      "a rung the machine cannot even bind no longer kills the run");
    check(/failed to LAUNCH on rung cheap \(backend not found on PATH: fixture-ghost-bin\)/.test(r.out),
      "the reason names the missing executable");
    check(/escalated \(launch failure\): cheap -> mid/.test(r.out), "and the task is promoted");
    check(jsonl(path.join(r.runDir, "escalations.jsonl"))[0].after_iteration === "0",
      "recorded as happening before any iteration ran");
    check(/^- Result: PASS/m.test(readIf(path.join(r.runDir, "task-001-result.md"))),
      "the task completes on the rung that IS installed");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true }); }
}

// ── 3b) NOTHING on the ladder is installed: climb, then halt ─────────────
console.log("3b) when no rung can even be bound, it climbs the whole ladder then halts");
{
  // Every rung's backend is missing, so each promotion also fails to bind and the
  // escalation has to keep climbing from the rung it just moved to.
  const bins = makeBins([], ["fixture-cheap", "fixture-cheap-ro", "fixture-mid",
    "fixture-strong", "fixture-backstop"]);
  const target = makeTarget();
  const plan = makePlan("# A task\ncomplexity:medium\n\nDo the thing.\n");
  try {
    const r = runBatch(target, bins, plan, ["--efficiency"]);
    check(r.status === 4 && /LAUNCH_ESCALATION_EXHAUSTED/.test(r.out),
      "the batch halts on the launch-escalation terminal status");
    check((r.out.match(/is unusable here — backend not found on PATH/g) || []).length === 3,
      "each further unbindable rung says so and keeps climbing (mid, strong, backstop)");
    check(/rungs tried: cheap -> mid -> strong -> backstop/.test(r.out),
      "the trail names every rung, even though none of them ever ran");
    check(readdirSync(r.runDir).filter((f) => /builder.*\.log$/.test(f)).length === 0,
      "no backend was ever launched — the bind check caught them all");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true }); }
}

// ── 4) BOUNDED: the ladder runs out and the batch halts clearly ──────────
console.log("4) bounded — every rung fails to launch, so the batch halts naming the rungs tried");
{
  const bins = makeBins(["fixture-cheap", "fixture-mid", "fixture-strong", "fixture-backstop"]);
  const target = makeTarget();
  const plan = makePlan("# A task\ncomplexity:medium\n\nDo the thing.\n");
  try {
    const r = runBatch(target, bins, plan, ["--efficiency"]);
    check(r.status === 4, "the batch halts with the backend-unavailable exit code (4)");
    check(/LAUNCH_ESCALATION_EXHAUSTED/.test(r.out)
      && !/^Batch BUILDER_UNAVAILABLE/m.test(r.out),
      "on its own terminal status, distinct from the single-backend halt");
    check(/rungs tried: cheap -> mid -> strong -> backstop/.test(r.out),
      "the banner names every rung it tried, in order, up to the backstop");
    check(builderLaunches(r.runDir) === 4,
      "exactly one builder launch per rung — bounded, never an infinite retry");
    check(jsonl(path.join(r.runDir, "escalations.jsonl")).map((e) => e.to_rung).join(",")
      === "mid,strong,backstop", "every promotion is recorded");
    check(/^STATUS=LAUNCH_ESCALATION_EXHAUSTED$/m.test(lastRun(target)),
      "last-run.env records the terminal status for status/resume/cleanup");
    check(/^LAUNCH_ESCALATION_ROLE=builder$/m.test(lastRun(target)),
      "and which role could not launch anywhere");
    const report = readIf(path.join(r.runDir, "final-report.md"));
    check(/## ⚠ Halted: no launchable rung left \(builder\)/.test(report)
      && /cheap -> mid -> strong -> backstop/.test(report),
      "the report explains the halt and names the whole trail");
    check(/cannot promote above rung 'backstop'/.test(report),
      "including why no further promotion was possible");
    check(!existsSync(path.join(r.runDir, "task-001-result.md")),
      "the halted task is not written up as a PASS/FAIL result");

    // The escalation events must not corrupt the usage report they share a file with:
    // three of the four ledger lines here are `event` records, and only the ONE round
    // line may be counted. (Token totals read "unknown" — the fixtures emit no usage
    // JSON — which is the honest answer, not a fabricated number.)
    const rep = spawnSync(process.execPath, [cliPath, "report", "--repo", target],
      { encoding: "utf-8", env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1" } });
    check(rep.status === 0 && /rounds \(total\): 1/.test(rep.stdout)
      && (rep.stdout.match(/^ {2}task-\d+:$/gm) || []).length === 1
      && !/escalation/.test(rep.stdout),
      "`ralph report` counts only the round line, inventing no ticket for the 3 escalation events");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true }); }
}

// ── 5) WITHOUT --efficiency the halt is byte-for-byte today's ────────────
console.log("5) no ladder => the existing BUILDER_UNAVAILABLE halt, unchanged");
{
  const bins = makeBins(["default-build"]);      // the operator's own builder cannot launch
  const withProfile = makeTarget();              // a profile exists but is never consulted
  const withoutProfile = makeTarget({ profile: null });
  const plan = makePlan();
  try {
    const a = runBatch(withProfile, bins, plan);
    const b = runBatch(withoutProfile, bins, plan);
    check(a.status === 4 && /BUILDER_UNAVAILABLE/.test(a.out),
      "the batch still halts as BUILDER_UNAVAILABLE (exit 4)");
    check(/Task 001 HALTED — builder backend unavailable/.test(a.out),
      "with today's HALTED line");
    check(!/escalat/i.test(a.out), "not one word about escalation is printed");
    check(!existsSync(path.join(a.runDir, "escalations.jsonl")),
      "no escalation artifact is written");
    check(!/LAUNCH_ESCAL/.test(lastRun(withProfile)),
      "last-run.env gains no launch-escalation fields");
    check(!existsSync(path.join(withProfile, ".ralph", "ledger.jsonl"))
      || jsonl(path.join(withProfile, ".ralph", "ledger.jsonl"))
        .every((rec) => rec.event !== "efficiency_escalation"),
      "and nothing is appended to the ledger as an escalation");

    const norm = (out, t) => out
      .split(t).join("<TARGET>")
      .split(path.basename(wtBase(t))).join("<WT>")
      .split(path.basename(t)).join("<NAME>")
      .replace(/batch-\d{8}-\d{6}-\d+/g, "batch-<RUN_ID>")
      // The two runs are sequential, so the USAGE line's wall clock can tick between
      // them. Everything else must match exactly.
      .replace(/timestamp=\d{4}-\d\d-\d\dT[\d:]+Z/g, "timestamp=<TS>")
      .replace(/\b[0-9a-f]{7,40}\b/g, "<SHA>");
    check(norm(a.out, withProfile) === norm(b.out, withoutProfile),
      "stdout+stderr is byte-for-byte identical with and without the profile present");

    // Efficiency ON but the task carries no tier: still no ladder, still today's halt.
    const untiered = makeTarget();
    const plainPlan = makePlan("# A task\n\nNobody sized this one.\n");
    try {
      const u = runBatch(untiered, bins, plainPlan, ["--efficiency"]);
      check(u.status === 4 && /BUILDER_UNAVAILABLE/.test(u.out),
        "an unsized task under --efficiency degrades to today's halt");
      check(!/escalated \(launch failure\)/.test(u.out), "with no promotion attempted");
    } finally { cleanup(untiered); rmSync(plainPlan, { recursive: true, force: true }); }
  } finally { cleanup(withProfile, withoutProfile); rmSync(bins, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true }); }
}

// ── 6) a launchable rung never escalates ─────────────────────────────────
console.log("6) when the first rung launches, nothing is escalated at all");
{
  const bins = makeBins();
  const target = makeTarget();
  const plan = makePlan();
  try {
    const r = runBatch(target, bins, plan, ["--efficiency"]);
    check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.out), "the batch completes");
    check(/builder: fixture-cheap /.test(readIf(path.join(r.runDir, "task-001-result.md"))),
      "on the rung the task was dispatched on");
    check(!/escalat/i.test(r.out) && !existsSync(path.join(r.runDir, "escalations.jsonl")),
      "with no escalation printed or recorded");
    check(!/Launch-failure escalation/.test(readIf(path.join(r.runDir, "task-001-result.md"))),
      "and no launch-escalation line in the PR body");
    check(!/LAUNCH_ESCAL/.test(lastRun(target)), "and no launch-escalation fields in last-run.env");
  } finally { cleanup(target); rmSync(bins, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true }); }
}

console.log(`\nlaunch-escalate: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
