// #22: a builder that exits 0 but changes nothing must NOT be recorded as success,
// even if a (weak) reviewer would rubber-stamp it. batch-loop's no-op guard fires
// after the builder, before check/reviewer.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");
let failures = 0;
const check = (c, m) => { if (c) console.log(`  ✔ ${m}`); else { console.error(`  x FAIL: ${m}`); failures++; } };
const g = (cwd, a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
function makeTarget() {
  const t = mkdtempSync(path.join(tmpdir(), "ralph-noop-"));
  g(t, ["init", "-q"]); g(t, ["config", "user.email", "t@e.com"]); g(t, ["config", "user.name", "t"]);
  mkdirSync(path.join(t, "scripts"));
  writeFileSync(path.join(t, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n"); chmodSync(path.join(t, "scripts", "check.sh"), 0o755);
  writeFileSync(path.join(t, "greet.txt"), "hello\n");
  writeFileSync(path.join(t, "ralph.target.json"), JSON.stringify({ check: "./scripts/check.sh", preflight: { enabled: false }, preview: { enabled: false } }));
  writeFileSync(path.join(t, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  g(t, ["add", "-A"]); g(t, ["commit", "-q", "-m", "init"]);
  return t;
}
const tmps = [];
function plan(body) { const d = mkdtempSync(path.join(tmpdir(), "ralph-noopplan-")); tmps.push(d); writeFileSync(path.join(d, "01-t.md"), body); return d; }
const wt = (t) => path.join(t, "..", `ralph-wt-${path.basename(t)}`);
function ralph(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", RALPH_AGENT_RETRY_DELAY: "0", ...env } });
}
function clean(t) { try { rmSync(wt(t), { recursive: true, force: true }); } catch {} rmSync(t, { recursive: true, force: true }); }

// A reviewer that ALWAYS passes — proves the guard, not the reviewer, is what stops a no-op.
const OKREV = 'bash -c "printf \\"### Must-fix\\n- none\\n\\nVERDICT: PASS\\n\\""';

console.log("1) builder exits 0 but changes nothing (writes only the gitignored handoff) -> NOT success");
{
  const t = makeTarget();
  // Mimics #22: claims completion, touches only .agent-handoff.md (gitignored) => empty diff.
  const NOOP = 'bash -c "printf \\"# handoff\\n- Completed. All tests pass. No changes needed.\\n\\" > .agent-handoff.md; echo \\"Task successfully completed.\\""';
  try {
    const r = ralph(["batch", "--repo", t, "--plan", plan("# Edit greet\nChange greet.txt from hello to hola.\n"),
      "--builder", "noop", "--reviewer", "okrev", "--max-tasks", "1", "--max-iterations", "2", "--auto-approve-builder"],
      { RALPH_WORKTREE_DIR: wt(t), AGENT_NOOP_CMD: NOOP, AGENT_OKREV_CMD: OKREV });
    const out = `${r.stdout}${r.stderr}`;
    check(/produced NO changes/i.test(out), "no-op is detected and announced");
    check(!/result: PASS/.test(out), "task is NOT recorded as PASS despite the reviewer PASS + exit 0");
    check(/NO_CHANGES/.test(out) || /completed: ?0/.test(out) || /failed: ?1/.test(out), "task tallied as a failure (NO_CHANGES), not completed");
    // No commit landed on the batch branch (nothing changed).
    const wtDir = path.join(wt(t), readdirSync(wt(t))[0]);
    const log = g(wtDir, ["log", "--oneline"]);
    check(!/ralph batch task/.test(log), "no per-task commit was created for a no-op");
  } finally { clean(t); }
}

console.log("2) control: a builder that DOES change a tracked file still passes (guard doesn't block real work)");
{
  const t = makeTarget();
  const REAL = 'bash -c "echo hola > greet.txt; printf \\"# handoff\\n- edited greet\\n\\" > .agent-handoff.md"';
  try {
    const r = ralph(["batch", "--repo", t, "--plan", plan("# Edit greet\nChange greet.txt to hola.\n"),
      "--builder", "real", "--reviewer", "okrev", "--max-tasks", "1", "--max-iterations", "2", "--auto-approve-builder"],
      { RALPH_WORKTREE_DIR: wt(t), AGENT_REAL_CMD: REAL, AGENT_OKREV_CMD: OKREV });
    const out = `${r.stdout}${r.stderr}`;
    check(/result: PASS/.test(out), "real change + reviewer PASS => task PASS");
    check(!/produced NO changes/i.test(out), "no-op guard did NOT misfire on a real change");
  } finally { clean(t); }
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\nbuilder-noop: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
