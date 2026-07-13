// Smoke tests for `ralph batch` (sequential multi-task, one shared worktree).
// Uses RALPH_DRY_RUN=1 so no real agents run; the check command still runs.
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✔ ${msg}`);
  else {
    console.error(`  x FAIL: ${msg}`);
    failures += 1;
  }
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function ralph(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", ...env },
  });
}
function writeScript(p, body) {
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}
function makeTarget(opts = {}) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-batch-"));
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  writeFileSync(path.join(target, "README.md"), "# T\n");
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  writeScript(path.join(target, "scripts", "check.sh"), `#!/usr/bin/env bash\nexit ${opts.checkFails ? 1 : 0}\n`);
  const cfg = { check: "./scripts/check.sh", preview: { enabled: false } };
  if (opts.preview) {
    writeScript(
      path.join(target, "scripts", "preview-up.sh"),
      "#!/usr/bin/env bash\necho UP app=$RALPH_APP_PORT proj=$RALPH_COMPOSE_PROJECT\nexit 0\n",
    );
    writeScript(path.join(target, "scripts", "preview-url.sh"), "#!/usr/bin/env bash\necho http://apps:${RALPH_APP_PORT}\n");
    writeScript(path.join(target, "scripts", "preview-down.sh"), "#!/usr/bin/env bash\necho DOWN\n");
    writeScript(
      path.join(target, "scripts", "e2e.sh"),
      `#!/usr/bin/env bash\necho "e2e url=$RALPH_PREVIEW_URL"\nexit ${opts.e2eFails ? 1 : 0}\n`,
    );
    cfg.preview = {
      enabled: true,
      up: "./scripts/preview-up.sh",
      down: "./scripts/preview-down.sh",
      url: "./scripts/preview-url.sh",
      e2e: "./scripts/e2e.sh",
      host: "apps",
    };
  }
  writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  return { target, mainHead: git(target, ["rev-parse", "HEAD"]) };
}
// Plans must live OUTSIDE the target repo (otherwise they'd make it dirty).
const planDirs = [];
function makePlanDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ralph-plan-"));
  planDirs.push(dir);
  // Intentionally out of lexical creation order to prove sorting.
  writeFileSync(path.join(dir, "02-greeting.md"), "# Add greeting\nAdd a hello line.\n");
  writeFileSync(path.join(dir, "01-setup.md"), "# Setup\nInitialize.\n");
  writeFileSync(path.join(dir, "03-footer.md"), "# Footer\nAdd a footer.\n");
  return dir;
}
function wtBase(target) {
  return path.join(target, "..", `ralph-wt-${path.basename(target)}`);
}
function batchRunDir(target) {
  const dir = path.join(target, ".agent-run");
  const d = readdirSync(dir).filter((x) => x.startsWith("batch-")).sort();
  return path.join(dir, d[d.length - 1]);
}
function cleanup(target) {
  try {
    rmSync(wtBase(target), { recursive: true, force: true });
  } catch {}
  rmSync(target, { recursive: true, force: true });
}

console.log("1) batch command exists + runs a multi-task plan in ONE worktree");
{
  const { target, mainHead } = makeTarget();
  const plan = makePlanDir();
  try {
    const r = ralph(
      [
        "batch",
        "--repo",
        target,
        "--plan",
        plan,
        "--builder",
        "claude",
        "--reviewer",
        "codex",
        "--auto-approve-builder",
      ],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, "batch exits 0 when all tasks pass");
    check(!/Unknown arg|requires|not found/i.test(out) || out.includes("BATCH"), "batch command is recognized");

    // Exactly one worktree for the whole batch.
    const wts = readdirSync(wtBase(target));
    check(wts.length === 1, `exactly one worktree created (got ${wts.length})`);

    // Tasks discovered in sorted order: Setup, Add greeting, Footer.
    const runDir = batchRunDir(target);
    const manifest = readFileSync(path.join(runDir, "tasks", "manifest.tsv"), "utf-8").trim().split("\n");
    check(manifest.length === 3, "three tasks discovered");
    check(/\tSetup\t/.test(manifest[0]), "task 1 = Setup (sorted by filename, not creation order)");
    check(/\tAdd greeting\t/.test(manifest[1]), "task 2 = Add greeting");
    check(/\tFooter\t/.test(manifest[2]), "task 3 = Footer");

    // Per-task result files + final report.
    for (const n of ["001", "002", "003"]) {
      check(existsSync(path.join(runDir, `task-${n}-result.md`)), `task-${n}-result.md written`);
    }
    check(existsSync(path.join(runDir, "final-report.md")), "final-report.md written");
    const report = readFileSync(path.join(runDir, "final-report.md"), "utf-8");
    check(/attempted: 3 .*completed: 3, failed: 0/.test(report), "report tallies 3/3 completed");
    check(/READY_FOR_HUMAN_REVIEW/.test(report), "report outcome READY_FOR_HUMAN_REVIEW");

    // No auto-merge: target's checked-out branch HEAD unchanged.
    check(git(target, ["rev-parse", "HEAD"]) === mainHead, "target main HEAD unchanged (no auto-merge)");
    // Per-task commits exist on the batch branch.
    const wt = path.join(wtBase(target), wts[0]);
    const log = git(wt, ["log", "--oneline", `${mainHead}..HEAD`]);
    check((log.match(/ralph batch task/g) || []).length === 3, "three per-task commits on the shared branch");
  } finally {
    cleanup(target);
  }
}

console.log("2) --auto-approve-builder affects ONLY the builder; reviewer stays read-only");
{
  const { target } = makeTarget();
  const plan = makePlanDir();
  try {
    // With --auto-approve-builder + claude builder + codex reviewer.
    ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "claude", "--reviewer", "codex", "--auto-approve-builder"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target) },
    );
    const cfg = readFileSync(path.join(batchRunDir(target), "config.resolved.env"), "utf-8");
    const builderCmd = (cfg.match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    const reviewerCmd = (cfg.match(/^REVIEWER_CMD=(.*)$/m) || [])[1] || "";
    check(/--dangerously-skip-permissions/.test(builderCmd), "auto-approve: builder keeps permission-skip flag");
    check(!/--dangerously-skip-permissions|--yolo/.test(reviewerCmd), "reviewer has NO permission-skip flags");
    check(/--sandbox read-only/.test(reviewerCmd), "codex reviewer uses the read-only sandbox");
    check(/AUTO_APPROVE_BUILDER=true/.test(cfg), "auto-approve is recorded explicitly in the log");
  } finally {
    cleanup(target);
  }
}

console.log("3) Without --auto-approve-builder the builder runs in manual mode");
{
  const { target } = makeTarget();
  const plan = makePlanDir();
  try {
    ralph(["batch", "--repo", target, "--plan", plan, "--builder", "claude", "--reviewer", "codex"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtBase(target),
    });
    const cfg = readFileSync(path.join(batchRunDir(target), "config.resolved.env"), "utf-8");
    const builderCmd = (cfg.match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    check(!/--dangerously-skip-permissions/.test(builderCmd), "manual: builder drops the permission-skip flag");
    check(/AUTO_APPROVE_BUILDER=false/.test(cfg), "manual mode recorded in the log");
  } finally {
    cleanup(target);
  }
}

console.log("4) single-file plan splits into tasks by heading");
{
  const { target } = makeTarget();
  const planRoot = mkdtempSync(path.join(tmpdir(), "ralph-plan-"));
  planDirs.push(planRoot);
  const planFile = path.join(planRoot, "plan.md");
  writeFileSync(planFile, "# First\ndo a\n\n# Second\ndo b\n\n# Third\ndo c\n");
  try {
    const r = ralph(["batch", "--repo", target, "--plan", planFile, "--max-tasks", "2"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtBase(target),
    });
    check(r.status === 0, "batch exits 0");
    const runDir = batchRunDir(target);
    const manifest = readFileSync(path.join(runDir, "tasks", "manifest.tsv"), "utf-8").trim().split("\n");
    check(manifest.length === 3, "single file split into 3 tasks by heading");
    // --max-tasks 2 => only two result files.
    check(existsSync(path.join(runDir, "task-002-result.md")), "task 2 ran");
    check(!existsSync(path.join(runDir, "task-003-result.md")), "--max-tasks 2 stopped before task 3");
    rmSync(planFile, { force: true });
  } finally {
    cleanup(target);
  }
}

console.log("5) preview enabled: end-of-batch preview brings up a URL for review");
{
  const { target } = makeTarget({ preview: true });
  const plan = makePlanDir();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "claude", "--reviewer", "codex", "--auto-approve-builder"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, "batch exits 0 (tasks + preview ok)");
    const runDir = batchRunDir(target);
    check(existsSync(path.join(runDir, "preview-up.log")), "preview-up.log written (one preview for the whole batch)");
    check(existsSync(path.join(runDir, "preview-url.txt")), "preview-url.txt written");
    check(existsSync(path.join(runDir, "e2e.log")), "e2e.log written");
    const url = readFileSync(path.join(runDir, "preview-url.txt"), "utf-8").trim();
    check(/^http:\/\/apps:\d+$/.test(url), `preview URL resolved (${url})`);
    check(out.includes("review the whole batch"), "terminal summary surfaces the preview URL");
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(new RegExp(`PREVIEW_URL=${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lastRun), "last-run.env records the preview URL");
    // Exactly one preview (not one per task): only a single preview-up.log.
    const upLogs = readdirSync(runDir).filter((f) => /^preview-up.*\.log$/.test(f));
    check(upLogs.length === 1, `exactly one preview-up across the batch (got ${upLogs.length})`);
  } finally {
    cleanup(target);
  }
}

console.log("6) preview enabled + failing e2e: COMPLETED_WITH_FAILURES but URL still returned");
{
  const { target } = makeTarget({ preview: true, e2eFails: true });
  const plan = makePlanDir();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "claude", "--reviewer", "codex", "--auto-approve-builder"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 2, "batch exits 2 when end-of-batch e2e fails");
    check(/COMPLETED_WITH_FAILURES/.test(out), "outcome downgraded to COMPLETED_WITH_FAILURES");
    const report = readFileSync(path.join(batchRunDir(target), "final-report.md"), "utf-8");
    check(/End-of-batch e2e FAILED/.test(report), "report lists the e2e failure as a blocker");
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(/PREVIEW_URL=http:\/\/apps:\d+/.test(lastRun), "URL still returned so the human can inspect");
  } finally {
    cleanup(target);
  }
}

console.log("7) --max-iterations: a task retries up to N times before failing");
{
  const { target } = makeTarget({ checkFails: true }); // check never passes -> task can't pass
  const plan = makePlanDir();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--max-tasks", "1", "--max-iterations", "3", "--builder", "claude", "--reviewer", "codex", "--auto-approve-builder"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target) },
    );
    check(r.status === 2, "batch exits 2 (task could not pass)");
    const runDir = batchRunDir(target);
    // Three builder attempts were made for task 001.
    for (const n of [1, 2, 3]) {
      check(existsSync(path.join(runDir, `task-001-iter-${n}-builder.log`)), `attempt ${n} ran (iter-${n} artifacts)`);
    }
    check(!existsSync(path.join(runDir, "task-001-iter-4-builder.log")), "stopped at max-iterations (no 4th attempt)");
    const result = readFileSync(path.join(runDir, "task-001-result.md"), "utf-8");
    check(/Attempts: 3 of 3/.test(result), "result records 3 of 3 attempts");
    check(/- Result: FAIL/.test(result), "task marked FAIL after exhausting attempts");
    // Builder prompt on attempt 2 carries the previous check feedback.
    const b2 = readFileSync(path.join(runDir, "task-001-iter-2-builder-prompt.md"), "utf-8");
    check(/Attempt 2 of 3/.test(b2), "attempt 2 prompt knows it is attempt 2 of 3");
  } finally {
    cleanup(target);
  }
}

console.log("8) default per-task budget is 5 attempts");
{
  const { target } = makeTarget({ checkFails: true });
  const plan = makePlanDir();
  try {
    ralph(["batch", "--repo", target, "--plan", plan, "--max-tasks", "1", "--builder", "claude", "--reviewer", "codex", "--auto-approve-builder"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtBase(target),
    });
    const runDir = batchRunDir(target);
    check(existsSync(path.join(runDir, "task-001-iter-5-builder.log")), "5th attempt ran by default");
    check(!existsSync(path.join(runDir, "task-001-iter-6-builder.log")), "no 6th attempt (default budget = 5)");
  } finally {
    cleanup(target);
  }
}

// Helpers for ERROR/resume tests: real (non-dry) shell backends + a 2-task plan.
const stateDirs = [];
function stateDir() {
  const d = mkdtempSync(path.join(tmpdir(), "ralph-state-"));
  stateDirs.push(d);
  return d;
}
function twoTaskPlan() {
  const dir = mkdtempSync(path.join(tmpdir(), "ralph-plan-"));
  planDirs.push(dir);
  writeFileSync(path.join(dir, "01.md"), "# Task one\nfirst\n");
  writeFileSync(path.join(dir, "02.md"), "# Task two\nsecond\n");
  return dir;
}
// builder: makes a change + handoff so there's something to commit. reviewer: varies.
const FB = 'bash -c "echo x >> progress.txt; printf \\"# handoff\\n\\" > .agent-handoff.md"';
const noDelay = { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "" };

console.log("9) reviewer ERROR (non-zero exit) -> REVIEWER_UNAVAILABLE, no builder attempt consumed");
{
  const { target, mainHead } = makeTarget();
  const plan = twoTaskPlan();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "reverr", "--auto-approve-builder", "--max-iterations", "5"],
      { ...noDelay, RALPH_WORKTREE_DIR: wtBase(target), AGENT_FB_CMD: FB, AGENT_REVERR_CMD: 'bash -c "echo boom >&2; exit 1"' },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 4, "exit code 4 (distinct from 2)");
    check(/REVIEWER_UNAVAILABLE/.test(out), "outcome REVIEWER_UNAVAILABLE");
    check(/re-?authenticate|login/i.test(out), "prints a re-login hint");
    check(/--resume/.test(out), "prints a resume command");
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(/STATUS=REVIEWER_UNAVAILABLE/.test(lastRun), "last-run.env STATUS=REVIEWER_UNAVAILABLE");
    const runDir = batchRunDir(target);
    // never consumed a builder attempt: no 2nd builder attempt for task 001
    check(!existsSync(path.join(runDir, "task-001-iter-2-builder-prompt.md")), "no 2nd builder attempt (ERROR didn't loop the builder)");
    // halted before committing/counting the task
    check(!existsSync(path.join(runDir, "task-001-result.md")), "halted task has no result file");
    check(git(target, ["rev-parse", "HEAD"]) === mainHead, "target main untouched");
  } finally {
    cleanup(target);
  }
}

console.log("10) reviewer with NO verdict line (exit 0) is ERROR, not FAIL");
{
  const { target } = makeTarget();
  const plan = twoTaskPlan();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "noverdict", "--auto-approve-builder"],
      { ...noDelay, RALPH_WORKTREE_DIR: wtBase(target), AGENT_FB_CMD: FB, AGENT_NOVERDICT_CMD: 'bash -c "echo looks fine to me; exit 0"' },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 4, "exit 4 (treated as ERROR/unavailable, not FAIL)");
    check(/REVIEWER_UNAVAILABLE/.test(out), "missing VERDICT => REVIEWER_UNAVAILABLE (not COMPLETED_WITH_FAILURES)");
    check(/verdict='none'|verdict=none/.test(out), "logs that no verdict was parsed");
  } finally {
    cleanup(target);
  }
}

console.log("11) builder ERROR (non-zero exit) -> BUILDER_UNAVAILABLE");
{
  const { target } = makeTarget();
  const plan = twoTaskPlan();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "builderr", "--reviewer", "okrev", "--auto-approve-builder"],
      { ...noDelay, RALPH_WORKTREE_DIR: wtBase(target), AGENT_BUILDERR_CMD: 'bash -c "echo crash >&2; exit 1"', AGENT_OKREV_CMD: 'bash -c "printf \\"VERDICT: PASS\\n\\""' },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 4, "exit 4 on builder outage");
    check(/BUILDER_UNAVAILABLE/.test(out), "outcome BUILDER_UNAVAILABLE");
    check(/builder ERROR \(exit=1\)/.test(out), "logs builder ERROR with exit code");
  } finally {
    cleanup(target);
  }
}

console.log("12) resume skips already-PASSed tasks after a halt");
{
  const { target } = makeTarget();
  const plan = twoTaskPlan();
  const st = stateDir();
  const counter = path.join(st, "n");
  try {
    // Reviewer passes the 1st call (task 1), errors afterwards (task 2) -> halt.
    const flakyRev = `bash -c 'c=$(cat ${counter} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${counter}; if [ $c -le 1 ]; then printf "VERDICT: PASS\\n"; else echo down; exit 1; fi'`;
    const r1 = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "flaky", "--auto-approve-builder"],
      { ...noDelay, RALPH_WORKTREE_DIR: wtBase(target), AGENT_FB_CMD: FB, AGENT_FLAKY_CMD: flakyRev },
    );
    check(r1.status === 4, "run 1 halts (REVIEWER_UNAVAILABLE)");
    check(existsSync(path.join(batchRunDir(target), "task-001-result.md")), "task 1 completed+recorded before the halt");

    // "Fix" the backend: resume with an always-PASS reviewer.
    const r2 = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "okrev", "--auto-approve-builder", "--resume"],
      { ...noDelay, RALPH_WORKTREE_DIR: wtBase(target), AGENT_FB_CMD: FB, AGENT_OKREV_CMD: 'bash -c "printf \\"VERDICT: PASS\\n\\""' },
    );
    const out = `${r2.stdout}${r2.stderr}`;
    check(r2.status === 0, "resume completes (exit 0)");
    check(/already complete \(resume\), skipping/.test(out), "task 1 skipped on resume (not rebuilt)");
    check(/READY_FOR_HUMAN_REVIEW/.test(out), "resume reaches READY_FOR_HUMAN_REVIEW");
    const t2 = readFileSync(path.join(batchRunDir(target), "task-002-result.md"), "utf-8");
    check(/- Result: PASS/.test(t2), "task 2 now PASSes on resume");
  } finally {
    cleanup(target);
  }
}

console.log("13) interrupt (SIGINT) mid-task leaves a resumable pointer");
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { target } = makeTarget();
  const plan = twoTaskPlan();
  try {
    // Builder commits task 1 quickly, then HANGS on task 2 so we can interrupt mid-run.
    const FB_HANG =
      `bash -c 'echo x >> progress.txt; printf "# h\\n" > .agent-handoff.md; if [ "$R_TASK_NUM" = "002" ]; then sleep 60; fi'`;
    const env = {
      ...process.env,
      RALPH_SKIP_UPDATE_CHECK: "1",
      RALPH_AGENT_RETRY_DELAY: "0",
      RALPH_WORKTREE_DIR: wtBase(target),
      AGENT_FBH_CMD: FB_HANG,
      AGENT_OKREV_CMD: 'bash -c "printf \\"VERDICT: PASS\\n\\""',
    };
    // detached:true => new process group, so a group SIGINT hits the shell + agent
    // (emulating a terminal Ctrl-C), letting batch-loop's trap fire.
    const child = spawn(
      process.execPath,
      [cliPath, "batch", "--repo", target, "--plan", plan, "--builder", "fbh", "--reviewer", "okrev", "--auto-approve-builder"],
      { env, stdio: "ignore", detached: true },
    );
    const runsRoot = path.join(target, ".agent-run");
    let runDir = null;
    for (let waited = 0; waited < 40000 && runDir === null; waited += 200) {
      if (existsSync(runsRoot)) {
        const dirs = readdirSync(runsRoot).filter((x) => x.startsWith("batch-")).sort();
        if (dirs.length) {
          const rd = path.join(runsRoot, dirs[dirs.length - 1]);
          // task 1 committed (result file) AND task 2 builder has started (hanging)
          if (existsSync(path.join(rd, "task-001-result.md")) && existsSync(path.join(rd, "task-002-iter-1-builder.log"))) {
            runDir = rd;
          }
        }
      }
      if (runDir === null) await sleep(200);
    }
    check(runDir !== null, "task 1 committed and task 2 builder running before interrupt");
    try {
      process.kill(-child.pid, "SIGINT"); // signal the whole group (like Ctrl-C)
    } catch {
      child.kill("SIGINT");
    }
    await new Promise((res) => child.on("exit", res));
    // Give batch-loop's trap a moment to write INTERRUPTED.
    for (let w = 0; w < 3000; w += 150) {
      const lr = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
      if (/STATUS=INTERRUPTED/.test(lr)) break;
      await sleep(150);
    }
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(/STATUS=(INTERRUPTED|RUNNING)/.test(lastRun), "interrupt left a resumable pointer (INTERRUPTED/RUNNING, not stale)");
    check(/^BRANCH=ralph\/batch-/m.test(lastRun), "pointer records the batch branch");
    check(/^WORKTREE=.+/m.test(lastRun), "pointer records the worktree");

    // Resume with a non-hanging builder; task 1 must be skipped.
    const r2 = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "okrev", "--auto-approve-builder", "--resume"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_WORKTREE_DIR: wtBase(target), AGENT_FB_CMD: FB, AGENT_OKREV_CMD: 'bash -c "printf \\"VERDICT: PASS\\n\\""' },
    );
    const out2 = `${r2.stdout}${r2.stderr}`;
    check(r2.status === 0, "resume after interrupt completes (exit 0)");
    check(/already complete \(resume\), skipping/.test(out2), "task 1 skipped on resume after interrupt");
    check(/READY_FOR_HUMAN_REVIEW/.test(out2), "resume reaches READY_FOR_HUMAN_REVIEW");
  } finally {
    cleanup(target);
  }
}

console.log("14) reviewer BLOCKED short-circuits the task and escalates (COMPLETED_WITH_BLOCKERS)");
{
  const { target } = makeTarget();
  const plan = twoTaskPlan();
  try {
    // Reviewer blocks task 1 (structural), passes task 2 — proves BLOCKED is terminal
    // for its task but the batch continues to independent tasks.
    const BLOCKREV =
      `bash -c 'if [ "$R_TASK_NUM" = "001" ]; then printf "### Must-fix issues\\n- none\\n\\n### Blocker report\\n- acceptance is self-contradictory\\n\\nVERDICT: BLOCKED\\n"; else printf "VERDICT: PASS\\n"; fi'`;
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "blockrev", "--auto-approve-builder"],
      { RALPH_WORKTREE_DIR: wtBase(target), AGENT_FB_CMD: FB, AGENT_BLOCKREV_CMD: BLOCKREV },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 2, "exit 2 (ran, not ready — needs human)");
    check(/verdict: BLOCKED/.test(out), "reviewer BLOCKED verdict is recognized");
    check(/Task 001 result: BLOCKED after 1\//.test(out), "blocked task short-circuits at attempt 1 (no retry loop)");
    check(/Batch COMPLETED_WITH_BLOCKERS/.test(out), "outcome COMPLETED_WITH_BLOCKERS");
    check(/Task 002 result: PASS/.test(out), "independent task 2 still ran and PASSed");

    const runsRoot = path.join(target, ".agent-run");
    const dirs = readdirSync(runsRoot).filter((x) => x.startsWith("batch-")).sort();
    const rd = path.join(runsRoot, dirs[dirs.length - 1]);
    check(!existsSync(path.join(rd, "task-001-iter-2-builder.log")), "no 2nd builder attempt for the blocked task");
    const rep = readFileSync(path.join(rd, "final-report.md"), "utf-8");
    check(/\|\s*001\s*\|.*\|\s*BLOCKED\s*\|/.test(rep), "per-task table marks task 1 BLOCKED");
    check(/BLOCKED — needs human/.test(rep), "failures/blockers section flags the blocked task for a human");
    check(/blocked: 1/.test(rep), "report counts blocked tasks");

    const lr = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(/STATUS=COMPLETED_WITH_BLOCKERS/.test(lr), "last-run.env records COMPLETED_WITH_BLOCKERS");
  } finally {
    cleanup(target);
  }
}

console.log("15) a bogus/empty verdict is still ERROR, not silently BLOCKED");
{
  const { target } = makeTarget();
  const plan = twoTaskPlan();
  try {
    // Reviewer prints no VERDICT line at all -> harness must treat as ERROR
    // (REVIEWER_UNAVAILABLE), never infer BLOCKED/FAIL from absence.
    const NOVERDICT = 'bash -c "printf \\"just some prose, no verdict line\\n\\""';
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "noverdict", "--auto-approve-builder"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_WORKTREE_DIR: wtBase(target), AGENT_FB_CMD: FB, AGENT_NOVERDICT_CMD: NOVERDICT },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(/REVIEWER_UNAVAILABLE/.test(out), "missing verdict => ERROR (REVIEWER_UNAVAILABLE), not BLOCKED");
    check(!/COMPLETED_WITH_BLOCKERS/.test(out), "no verdict is never treated as BLOCKED");
  } finally {
    cleanup(target);
  }
}

for (const d of [...planDirs, ...stateDirs]) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
}

if (failures) {
  console.error(`\nBatch smoke tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nBatch smoke tests passed.");
