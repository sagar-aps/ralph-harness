import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "ralph");
let failures = 0;
const check = (ok, message) => ok ? console.log(`  ✔ ${message}`) : (console.error(`  x FAIL: ${message}`), failures++);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitChild = (child) => new Promise((resolve) => child.on("exit", (status) => resolve(status)));
const collectChild = (child) => new Promise((resolve) => {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", (status) => resolve({ status, output }));
});

function fixture() {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-batch-lock-"));
  const plan = mkdtempSync(path.join(tmpdir(), "ralph-batch-lock-plan-"));
  for (const command of [["init", "-q"], ["config", "user.email", "t@e.com"], ["config", "user.name", "t"]]) spawnSync("git", command, { cwd: target });
  mkdirSync(path.join(target, "scripts"));
  writeFileSync(path.join(target, "README.md"), "# fixture\n");
  writeFileSync(path.join(target, "scripts", "check.sh"), "#!/usr/bin/env bash\nif [[ -n \"${LOCK_TEST_CHILD_PID_FILE:-}\" ]]; then echo $$ > \"$LOCK_TEST_CHILD_PID_FILE\"; fi\nsleep \"${LOCK_TEST_SLEEP:-0}\"\n");
  chmodSync(path.join(target, "scripts", "check.sh"), 0o755);
  writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify({ check: "./scripts/check.sh", preview: { enabled: false } }));
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n");
  spawnSync("git", ["add", "-A"], { cwd: target });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: target });
  writeFileSync(path.join(plan, "task.md"), "# Lock fixture\nRun once.\n");
  return { target, plan, worktrees: `${target}-worktrees` };
}
const args = (f) => [cli, "batch", "--repo", f.target, "--plan", f.plan, "--max-tasks", "1"];
const env = (f, seconds = "0", extra = {}) => ({ ...process.env, BRANCH: "", RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", RALPH_DRY_RUN: "1", RALPH_PRIMER_OPTOUT: "1", RALPH_WORKTREE_DIR: f.worktrees, LOCK_TEST_SLEEP: seconds, ...extra });
async function waitForLock(f) {
  const lock = path.join(f.target, ".ralph", "batch.lock");
  for (let i = 0; i < 100; i++) {
    if (existsSync(lock) && /run=batch-.*pid=\d+/.test(readFileSync(lock, "utf8"))) return;
    await sleep(25);
  }
  throw new Error(`batch lock was not acquired: ${lock}`);
}
async function waitForFile(file) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file) && readFileSync(file, "utf8").trim()) return;
    await sleep(25);
  }
  throw new Error(`fixture child did not start: ${file}`);
}
function clean(f) {
  rmSync(f.target, { recursive: true, force: true });
  rmSync(f.plan, { recursive: true, force: true });
  rmSync(f.worktrees, { recursive: true, force: true });
}

console.log("batch target lock: overlapping, sequential, and override fixtures");
{
  const f = fixture();
  try {
    // Start all contenders together rather than waiting for metadata publication.
    // Exactly one owns the flock; every loser must still identify its live owner.
    const contenders = Array.from({ length: 8 }, () => spawn(process.execPath, args(f), { env: env(f, "2"), stdio: ["ignore", "pipe", "pipe"] }));
    const results = await Promise.all(contenders.map(collectChild));
    check(results.filter((result) => result.status === 0).length === 1, "simultaneous startup admits exactly one batch");
    const refusals = results.filter((result) => result.status !== 0);
    check(refusals.length === 7 && refusals.every((result) => /Another batch is already active.*run=batch-.*pid=\d+/s.test(result.output)), "startup-race refusals always name the active run and pid");
  } finally { clean(f); }
}
{
  const f = fixture();
  try {
    const first = spawn(process.execPath, args(f), { env: env(f, "2"), stdio: "ignore" });
    await waitForLock(f);
    const second = spawnSync(process.execPath, args(f), { env: env(f), encoding: "utf8" });
    check(second.status !== 0, "a second overlapping batch is refused");
    check(/Another batch is already active.*run=batch-.*pid=\d+/s.test(`${second.stdout}${second.stderr}`), "refusal names the active run and pid");
    const forgedSentinel = spawnSync(process.execPath, args(f), { env: env(f, "0", { RALPH_BATCH_LOCK_HELD: "1" }), encoding: "utf8" });
    check(forgedSentinel.status !== 0, "the removed environment sentinel cannot bypass the lock");
    check(await waitChild(first) === 0, "the lock holder completes normally");
    const sequential = spawnSync(process.execPath, args(f), { env: env(f), encoding: "utf8" });
    check(sequential.status === 0, `a later batch starts after automatic lock release${sequential.status === 0 ? "" : `: ${sequential.stderr}`}`);
  } finally { clean(f); }
}
{
  const f = fixture();
  const childPidFile = path.join(f.target, ".ralph", "check-child.pid");
  let childPid;
  try {
    const holder = spawn(process.execPath, args(f), { env: env(f, "20", { LOCK_TEST_CHILD_PID_FILE: childPidFile }), stdio: "ignore" });
    await waitForLock(f);
    await waitForFile(childPidFile);
    childPid = Number(readFileSync(childPidFile, "utf8").trim());
    const lockText = readFileSync(path.join(f.target, ".ralph", "batch.lock"), "utf8");
    const holderPid = Number((lockText.match(/pid=(\d+)/) || [])[1]);
    process.kill(holderPid, "SIGKILL");
    await waitChild(holder);
    check(process.kill(childPid, 0) === true, "the killed batch leaves its check descendant running");
    const afterKill = spawnSync(process.execPath, args(f), { env: env(f), encoding: "utf8" });
    check(afterKill.status === 0, `a surviving descendant cannot retain the killed batch's lock${afterKill.status === 0 ? "" : `: ${afterKill.stderr}`}`);
  } finally {
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    clean(f);
  }
}
for (const override of ["flag", "env"]) {
  const f = fixture();
  try {
    const first = spawn(process.execPath, args(f), { env: env(f, "2"), stdio: "ignore" });
    await waitForLock(f);
    const concurrentArgs = override === "flag" ? [...args(f), "--allow-concurrent"] : args(f);
    const concurrentEnv = override === "env" ? { ...env(f), RALPH_ALLOW_CONCURRENT: "1" } : env(f);
    const concurrent = spawnSync(process.execPath, concurrentArgs, { env: concurrentEnv, encoding: "utf8" });
    check(concurrent.status === 0, `${override === "flag" ? "--allow-concurrent" : "RALPH_ALLOW_CONCURRENT=1"} bypasses the held lock${concurrent.status === 0 ? "" : `: ${concurrent.stderr}`}`);
    check(await waitChild(first) === 0, "the original locked batch remains healthy");
  } finally { clean(f); }
}

if (failures) process.exit(1);
console.log("batch lock fixtures passed.");
