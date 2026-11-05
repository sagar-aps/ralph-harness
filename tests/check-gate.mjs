#!/usr/bin/env node
// #98: a gate (CHECK_CMD/VERIFY_CMD) that cannot RUN must not burn builder attempts.
// Startup repairs a non-executable script / a gitignored relative path and rejects a
// syntax error; at runtime exit 126/127 (or a bash parse error) halts as CHECK_BROKEN.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const scratch = mkdtempSync(path.join(tmpdir(), "ralph-checkgate-"));
let n = 0;
function makeTarget() {
  n += 1;
  const target = path.join(scratch, `target-${n}`);
  git(scratch, ["init", "-q", target]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  writeFileSync(path.join(target, "README.md"), "# T\n");
  writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify({ check: "true", preview: { enabled: false } }));
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  return target;
}
function run(target, extraArgs) {
  const planDir = path.join(scratch, `plan-${n}`);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(path.join(planDir, "01-task.md"), "# Do it\nDo the thing.\n");
  const r = spawnSync(
    process.execPath,
    [cliPath, "batch", "--repo", target, "--plan", planDir, "--builder", "claude", "--reviewer", "codex",
      "--auto-approve-builder", "--max-iterations", "3", ...extraArgs],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        RALPH_SKIP_UPDATE_CHECK: "1",
        RALPH_NO_LOCAL_CONFIG: "1",
        RALPH_DRY_RUN: "1",
        RALPH_AGENT_RETRY_DELAY: "0",
        RALPH_WORKTREE_DIR: path.join(scratch, `wt-${n}`),
      },
    },
  );
  const runRoot = path.join(target, ".agent-run");
  const runs = existsSync(runRoot) ? readdirSync(runRoot).filter((d) => d.startsWith("batch-")).sort() : [];
  const runDir = runs.length ? path.join(runRoot, runs[runs.length - 1]) : null;
  const report = runDir && existsSync(path.join(runDir, "final-report.md"))
    ? readFileSync(path.join(runDir, "final-report.md"), "utf-8") : "";
  const checkLogs = runDir ? readdirSync(runDir).filter((f) => /^task-001-iter-\d+-check\.log$/.test(f)) : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, report, checkLogs, runDir };
}
function script(p, body, mode) {
  writeFileSync(p, body);
  chmodSync(p, mode);
}

console.log("A) check script written without +x (the Memorix #976 case) -> run via its shebang, batch passes");
{
  const t = makeTarget();
  const s = path.join(t, ".ralph", "check-noexec.sh");
  script(s, "#!/usr/bin/env bash\nexit 0\n", 0o644);
  const r = run(t, ["--check", s]);
  check(/NOTICE: CHECK_CMD \(--check\) script .* is not executable/.test(r.out), "prints a notice");
  check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.report), "batch is READY_FOR_HUMAN_REVIEW");
}

console.log("B) relative path into gitignored .ralph/ (absent in the worktree) -> resolved against the target");
{
  const t = makeTarget();
  script(path.join(t, ".ralph", "check.sh"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  const r = run(t, ["--check", ".ralph/check.sh"]);
  check(/NOTICE: CHECK_CMD .* missing in the worktree/.test(r.out), "prints a notice");
  check(r.status === 0 && /READY_FOR_HUMAN_REVIEW/.test(r.report), "batch is READY_FOR_HUMAN_REVIEW");
}

console.log("C) check not found at runtime (exit 127) -> CHECK_BROKEN after ONE attempt");
{
  const t = makeTarget();
  const r = run(t, ["--check", "./scripts/nope.sh"]);
  check(/CHECK_BROKEN/.test(r.report), "final report outcome is CHECK_BROKEN");
  check(/gate command could not run \(check exit 127\)/.test(r.report), "report names the exit code");
  check(r.checkLogs.length === 1, `only one attempt spent (got ${r.checkLogs.length})`);
  check(!existsSync(path.join(r.runDir, "task-001-iter-1-reviewer.md")), "reviewer was not invoked");
}

console.log("D) inline syntax error in --check -> refused at startup, before any attempt");
{
  const t = makeTarget();
  const r = run(t, ["--check", "{ true"]);
  check(r.status !== 0 && /not valid shell \(bash -n failed\)/.test(r.out), "dies with a clear message");
  check(r.checkLogs.length === 0, "no attempt was spent");
}

console.log("E) a real check failure (exit 1) still iterates to max-iterations");
{
  const t = makeTarget();
  const r = run(t, ["--check", "false"]);
  check(/COMPLETED_WITH_FAILURES/.test(r.report), "outcome is COMPLETED_WITH_FAILURES");
  check(r.checkLogs.length === 3, `all 3 attempts used (got ${r.checkLogs.length})`);
}

console.log("F) verify not found (exit 127) after check+reviewer pass -> CHECK_BROKEN");
{
  const t = makeTarget();
  const r = run(t, ["--check", "true", "--verify", "./scripts/no-verify.sh"]);
  check(/CHECK_BROKEN/.test(r.report) && /verify exit 127/.test(r.report), "verify gate error halts as CHECK_BROKEN");
}

rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.error(`\nCheck-gate tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nCheck-gate tests passed.");
