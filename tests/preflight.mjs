// Smoke tests for the repo-contract preflight phase.
// Preflight runs configured install/check/test/e2e against the baseline BEFORE
// any worktree/agent, and blocks (exit 3) on failure.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, chmodSync, rmSync } from "node:fs";
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
    env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", ...env },
  });
}
// preflightTest: shell command used as the preflight "test" step ("true"|"false").
function makeTarget({ preflightTest } = {}) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-pf-"));
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  writeFileSync(path.join(target, "README.md"), "# T\n");
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  const checkSh = path.join(target, "scripts", "check.sh");
  writeFileSync(checkSh, "#!/usr/bin/env bash\nexit 0\n"); // in-loop check always passes
  chmodSync(checkSh, 0o755);
  mkdirSync(path.join(target, ".agents", "tasks"), { recursive: true });
  writeFileSync(
    path.join(target, ".agents", "tasks", "prd.json"),
    JSON.stringify({ version: 1, project: "t", qualityGates: [], stories: [{ id: "US-001", title: "x", status: "open", dependsOn: [], acceptanceCriteria: ["a"] }] }, null, 2),
  );
  const cfg = {
    check: "./scripts/check.sh",
    preflight: { enabled: true, install: "true", check: "./scripts/check.sh", test: preflightTest || "true" },
    preview: { enabled: false },
  };
  writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  return target;
}
function wtBase(target) {
  return path.join(target, "..", `ralph-wt-${path.basename(target)}`);
}
function cleanup(target) {
  try {
    const wb = wtBase(target);
    if (existsSync(wb)) {
      for (const d of readdirSync(wb)) {
        spawnSync("git", ["-C", path.join(wb, d), "worktree", "prune"], { encoding: "utf-8" });
      }
      rmSync(wb, { recursive: true, force: true });
    }
  } catch {}
  rmSync(target, { recursive: true, force: true });
}
function countWorktrees(target) {
  const wb = wtBase(target);
  return existsSync(wb) ? readdirSync(wb).length : 0;
}

console.log("1) standalone `ralph preflight` passes / fails with a report");
{
  const ok = makeTarget({ preflightTest: "true" });
  const bad = makeTarget({ preflightTest: "false" });
  try {
    const rOk = ralph(["preflight", "--repo", ok]);
    check(rOk.status === 0, "preflight exits 0 when all steps pass");
    check(/passed/i.test(`${rOk.stdout}${rOk.stderr}`), "reports passed");

    const rBad = ralph(["preflight", "--repo", bad]);
    check(rBad.status === 3, "preflight exits 3 when a step fails");
    const out = `${rBad.stdout}${rBad.stderr}`;
    check(/FAILED at step 'test'/.test(out), "names the failing step (test)");
    // a report file exists in .ralph/
    const reports = readdirSync(path.join(bad, ".ralph")).filter((f) => f.startsWith("preflight-"));
    check(reports.length >= 1, "preflight report written under .ralph/");
  } finally {
    cleanup(ok);
    cleanup(bad);
  }
}

console.log("2) review is BLOCKED by a failing preflight (no worktree, no agents)");
{
  const target = makeTarget({ preflightTest: "false" });
  try {
    const r = ralph(["review", "1", "--repo", target, "--builder", "claude", "--reviewer", "codex"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtBase(target),
    });
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 3, "review exits 3 on preflight failure");
    check(/Preflight failed/i.test(out), "explains the preflight failure");
    check(countWorktrees(target) === 0, "NO worktree was created");
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(/STATUS=PREFLIGHT_FAILED/.test(lastRun), "last-run.env records PREFLIGHT_FAILED");
    const runs = path.join(target, ".ralph", "runs");
    const runDir = path.join(runs, readdirSync(runs)[0]);
    check(existsSync(path.join(runDir, "preflight.md")), "preflight.md report written in the run dir");
    check(/— FAIL/.test(readFileSync(path.join(runDir, "preflight.md"), "utf-8")), "report marks FAIL");
  } finally {
    cleanup(target);
  }
}

console.log("3) --no-preflight bypasses preflight and the run proceeds");
{
  const target = makeTarget({ preflightTest: "false" });
  try {
    const r = ralph(
      ["review", "1", "--repo", target, "--builder", "claude", "--reviewer", "codex", "--no-preflight", "--max-iterations", "1"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, "review exits 0 when preflight is skipped (in-loop check passes)");
    check(/READY_FOR_HUMAN_REVIEW/.test(out), "reaches READY_FOR_HUMAN_REVIEW");
    check(countWorktrees(target) === 1, "worktree created because preflight was skipped");
  } finally {
    cleanup(target);
  }
}

console.log("4) batch is BLOCKED by a failing preflight");
{
  const target = makeTarget({ preflightTest: "false" });
  const planDir = mkdtempSync(path.join(tmpdir(), "ralph-plan-"));
  writeFileSync(path.join(planDir, "01.md"), "# A\nx\n");
  try {
    const r = ralph(["batch", "--repo", target, "--plan", planDir, "--builder", "claude", "--reviewer", "codex", "--auto-approve-builder"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtBase(target),
    });
    check(r.status === 3, "batch exits 3 on preflight failure");
    check(countWorktrees(target) === 0, "NO worktree was created for the batch");
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(/STATUS=PREFLIGHT_FAILED/.test(lastRun), "last-run.env records PREFLIGHT_FAILED");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
    cleanup(target);
  }
}

console.log("5) a target with no preflight config is a no-op (does not block)");
{
  const target = makeTarget({ preflightTest: "true" });
  // strip the preflight block
  const cfgPath = path.join(target, "ralph.target.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  delete cfg.preflight;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  git(target, ["commit", "-aqm", "drop preflight"]);
  try {
    const r = ralph(["preflight", "--repo", target]);
    check(r.status === 0, "standalone preflight is a no-op without config");
    check(/skipped/i.test(`${r.stdout}${r.stderr}`), "reports skipped (nothing configured)");
  } finally {
    cleanup(target);
  }
}

if (failures) {
  console.error(`\nPreflight smoke tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nPreflight smoke tests passed.");
