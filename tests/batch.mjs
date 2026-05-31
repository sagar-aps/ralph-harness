// Smoke tests for `ralph batch` (sequential multi-task, one shared worktree).
// Uses RALPH_DRY_RUN=1 so no real agents run; the check command still runs.
import { spawnSync } from "node:child_process";
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
function makeTarget() {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-batch-"));
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  writeFileSync(path.join(target, "README.md"), "# T\n");
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  const checkSh = path.join(target, "scripts", "check.sh");
  writeFileSync(checkSh, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(checkSh, 0o755);
  writeFileSync(
    path.join(target, "ralph.target.json"),
    JSON.stringify({ check: "./scripts/check.sh", preview: { enabled: false } }, null, 2),
  );
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

for (const d of planDirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
}

if (failures) {
  console.error(`\nBatch smoke tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nBatch smoke tests passed.");
