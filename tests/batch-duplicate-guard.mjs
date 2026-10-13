#!/usr/bin/env node
// Duplicate-dispatch guard: a fresh `ralph batch` refuses to start when an open PR
// already references an issue its tasks name (#74 regression: two unattended rounds
// each filed a PR for the same still-open ticket). gh is stubbed via RALPH_GH.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const scratch = mkdtempSync(path.join(tmpdir(), "ralph-dupguard-"));
const target = path.join(scratch, "target");
git(scratch, ["init", "-q", target]);
git(target, ["config", "user.email", "t@e.com"]);
git(target, ["config", "user.name", "t"]);
writeFileSync(path.join(target, "README.md"), "# T\n");
writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify({ check: "true", preview: { enabled: false } }));
writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
git(target, ["add", "-A"]);
git(target, ["commit", "-q", "-m", "init"]);

// gh stub: logs each call, prints $STUB_PRS (or fails when STUB_FAIL=1).
const callLog = path.join(scratch, "gh-calls.log");
const ghStub = path.join(scratch, "gh-stub.sh");
writeFileSync(
  ghStub,
  `#!/usr/bin/env bash\necho "$*" >> "${callLog}"\n[[ "\${STUB_FAIL:-}" == 1 ]] && exit 1\nprintf '%s' "$STUB_PRS"\n`,
);
chmodSync(ghStub, 0o755);

let n = 0;
function run({ title, prs = [], extraArgs = [], env = {} }) {
  n += 1;
  const planDir = path.join(scratch, `plan-${n}`);
  spawnSync("mkdir", ["-p", planDir]);
  writeFileSync(path.join(planDir, "01-task.md"), `# ${title}\nDo the thing.\n`);
  const wt = path.join(scratch, `wt-${n}`);
  rmSync(callLog, { force: true });
  const r = spawnSync(
    process.execPath,
    [cliPath, "batch", "--repo", target, "--plan", planDir, "--builder", "claude", "--reviewer", "codex",
      "--auto-approve-builder", ...extraArgs],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        RALPH_SKIP_UPDATE_CHECK: "1",
        RALPH_NO_LOCAL_CONFIG: "1",
        RALPH_DRY_RUN: "1",
        RALPH_WORKTREE_DIR: wt,
        RALPH_GH: ghStub,
        STUB_PRS: JSON.stringify(prs),
        RALPH_FIXES: "",
        ...env,
      },
    },
  );
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    worktreeMade: existsSync(wt) && readdirSync(wt).length > 0,
    ghCalled: existsSync(callLog),
  };
}

const pr806 = { number: 806, title: "ralph: ralph/batch-1", body: "Implements it.\n\nFixes #804\n", headRefName: "ralph/batch-1", commits: [] };

console.log("A) open PR body 'Fixes #N' for a task's issue -> refused before any worktree");
{
  const r = run({ title: "Issue #804 — Printed GST row labels", prs: [pr806] });
  check(r.status !== 0, "batch exits non-zero");
  check(/Duplicate dispatch refused/.test(r.out) && /#804 -> open PR #806 \(body closes it/.test(r.out), "names the issue and the covering PR");
  check(!r.worktreeMade, "no worktree was created");
}

console.log("B) --allow-duplicate overrides the guard");
{
  const r = run({ title: "Issue #804 — reviewfix", prs: [pr806], extraArgs: ["--allow-duplicate"] });
  check(r.status === 0, "batch exits 0");
  check(!r.ghCalled, "gh is not consulted when overridden");
}

console.log("C) body lacks Fixes, but a commit subject names the issue -> refused");
{
  const pr = { number: 808, title: "Fix printed GST", body: "no refs here", headRefName: "ralph/batch-2",
    commits: [{ messageHeadline: "ralph batch task 001: Issue #804 — labels" }] };
  const r = run({ title: "Issue #804 — again", prs: [pr] });
  check(r.status !== 0 && /#804 -> open PR #808 \(commit subject mentions it/.test(r.out), "commit headline counts as a reference");
}

console.log("D) branch name carries the issue -> refused");
{
  const pr = { number: 9, title: "x", body: "", headRefName: "fix/804-gst", commits: [] };
  const r = run({ title: "Issue #804", prs: [pr] });
  check(r.status !== 0 && /branch name carries it/.test(r.out), "fix/<N>-slug branch counts as a reference");
}

console.log("E) near-miss numbers (#8040, Fixes #80) do not match -> proceeds");
{
  const pr = { number: 10, title: "Issue #8040", body: "Fixes #80", headRefName: "fix/8040-x",
    commits: [{ messageHeadline: "touches #80401" }] };
  const r = run({ title: "Issue #804 — fresh", prs: [pr] });
  check(r.status === 0, "batch exits 0");
  check(/Duplicate guard: no open PR references #804/.test(r.out), "prints the ok line");
}

console.log("F) RALPH_FIXES alone supplies the issue ref");
{
  const r = run({ title: "Plain task title", prs: [pr806], env: { RALPH_FIXES: "#804" } });
  check(r.status !== 0 && /#804 -> open PR #806/.test(r.out), "RALPH_FIXES ref is guarded too");
}

console.log("G) no issue refs at all -> gh never called");
{
  const r = run({ title: "Plain task title", prs: [pr806] });
  check(r.status === 0 && !r.ghCalled, "exits 0 without listing PRs");
}

console.log("H) gh fails -> warn and continue (fail-open)");
{
  const r = run({ title: "Issue #804", prs: [pr806], env: { STUB_FAIL: "1" } });
  check(r.status === 0, "batch exits 0");
  check(/duplicate guard could not list open PRs/.test(r.out), "warns that the run is unguarded");
}

console.log("I) non-GitHub target without RALPH_GH -> guard skipped");
{
  const r = run({ title: "Issue #804", prs: [pr806], env: { RALPH_GH: "" } });
  check(r.status === 0 && !r.ghCalled, "local-only repos are unaffected");
}

rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.error(`\nDuplicate-guard tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nDuplicate-guard tests passed.");
