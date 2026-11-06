#!/usr/bin/env node
// `ralph integrate --pr` when the run's branch already has a PR. It used to skip the
// push and the create for ANY existing PR, so:
//   - a MERGED/CLOSED PR silently swallowed a PASSing result (Memorix 2026-11-06:
//     a reviewfix pushed onto PR #981 two minutes after it merged);
//   - an OPEN PR never received the run's new commits.
// Hermetic: a bare origin and a stub `gh` on PATH; no network.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

let failures = 0;
function check(cond, msg, detail = "") {
  if (cond) console.log(`  ✔ ${msg}`);
  else {
    console.error(`  x FAIL: ${msg}${detail ? `\n${detail}` : ""}`);
    failures += 1;
  }
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function writeExec(p, body) {
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

// Stub gh: `pr list` reports a PR in $RALPH_TEST_PR_STATE (none when unset).
const STUB_GH = `#!/usr/bin/env bash
{ printf 'gh'; printf ' %s' "$@"; printf '\\n'; } >> "$RALPH_TEST_GH_LOG"
if [[ "\${1:-}" == "--version" ]]; then echo "gh version 0.0.0 (stub)"; exit 0; fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then
  [[ -n "\${RALPH_TEST_PR_STATE:-}" ]] && printf '{"url":"https://example.invalid/pull/7","state":"%s"}\\n' "$RALPH_TEST_PR_STATE"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "create" ]]; then echo "https://example.invalid/pull/8"; exit 0; fi
exit 0
`;

const work = mkdtempSync(path.join(tmpdir(), "ralph-existing-pr-"));
let n = 0;
function makeTarget({ divergeRemote = false } = {}) {
  n += 1;
  const dir = path.join(work, `case-${n}`);
  const origin = path.join(dir, "origin.git");
  const target = path.join(dir, "target");
  mkdirSync(origin, { recursive: true });
  mkdirSync(target);
  git(origin, ["init", "-q", "--bare", "--initial-branch=main", origin]);
  git(target, ["init", "-q", "--initial-branch=main"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  writeFileSync(path.join(target, "README.md"), "# T\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-qm", "base"]);
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-qu", "origin", "main"]);

  const branch = "issue-981-reviewfix";
  git(target, ["checkout", "-qb", branch]);
  writeFileSync(path.join(target, "a.txt"), "round 2\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-qm", "round 2"]);
  git(target, ["push", "-q", "origin", branch]); // the PR's existing head
  if (divergeRemote) {
    // Someone else moved the PR head: our next commit is no longer a fast-forward.
    const other = path.join(dir, "other");
    git(dir, ["clone", "-q", "--branch", branch, origin, other]);
    git(other, ["config", "user.email", "o@e.com"]);
    git(other, ["config", "user.name", "o"]);
    writeFileSync(path.join(other, "b.txt"), "theirs\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-qm", "theirs"]);
    git(other, ["push", "-q", "origin", branch]);
  }
  writeFileSync(path.join(target, "a.txt"), "round 3\n");
  git(target, ["commit", "-qam", "round 3"]); // this run's new commit
  git(target, ["checkout", "-q", "main"]);

  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  writeFileSync(
    path.join(target, ".ralph", "last-run.env"),
    ["RUN_ID=20261106-000000-000000", "STATUS=READY_FOR_HUMAN_REVIEW", `BRANCH=${branch}`, `TARGET_REPO=${target}`, ""].join("\n"),
  );
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeExec(path.join(bin, "gh"), STUB_GH);
  return { target, origin, branch, bin, ghLog: path.join(dir, "gh.log") };
}
function integrate(t, prState) {
  const env = { ...process.env };
  delete env.RALPH_IDENTITY_WRAPPER;
  delete env.RALPH_IN_PREFLIGHT;
  const r = spawnSync(process.execPath, [cliPath, "integrate", "--repo", t.target, "--pr", "--keep-worktree"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...env,
      PATH: `${t.bin}:${process.env.PATH}`,
      RALPH_SKIP_UPDATE_CHECK: "1",
      RALPH_NO_LOCAL_CONFIG: "1",
      RALPH_TEST_GH_LOG: t.ghLog,
      ...(prState ? { RALPH_TEST_PR_STATE: prState } : {}),
    },
  });
  const ghLog = existsSync(t.ghLog) ? readFileSync(t.ghLog, "utf-8") : "";
  const remoteTip = git(t.origin, ["rev-parse", t.branch]);
  const localTip = git(t.target, ["rev-parse", t.branch]);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, ghLog, remoteTip, localTip };
}

for (const state of ["MERGED", "CLOSED"]) {
  console.log(`${state === "MERGED" ? "A" : "B"}) the branch's PR is ${state} -> refuse loudly, push nothing`);
  const t = makeTarget();
  const r = integrate(t, state);
  check(r.status === 3, `exits 3 (got ${r.status})`, r.out);
  check(new RegExp(`already ${state}`).test(r.out) && /NEW PR/.test(r.out), "says the PR is dead and to file a new one");
  check(r.remoteTip !== r.localTip, "the run's commit was NOT pushed onto the dead PR branch");
  check(!/pr create/.test(r.ghLog), "no PR was created");
}

console.log("C) the branch's PR is OPEN -> push the new commits to it, create nothing");
{
  const t = makeTarget();
  const r = integrate(t, "OPEN");
  check(r.status === 0, "exits 0", r.out);
  check(r.remoteTip === r.localTip, "origin's PR branch now has the run's commit");
  check(/Updated the open PR/.test(r.out), "reports the update");
  check(!/pr create/.test(r.ghLog), "no second PR was created");
}

console.log("D) OPEN, but the PR head moved (non-fast-forward) -> refuse, never force");
{
  const t = makeTarget({ divergeRemote: true });
  const r = integrate(t, "OPEN");
  check(r.status !== 0, "exits non-zero");
  check(/was NOT updated/.test(r.out), "says the open PR was not updated");
  check(r.remoteTip !== r.localTip, "the remote head was not overwritten");
}

console.log("E) no PR yet -> push + create (unchanged)");
{
  const t = makeTarget();
  const r = integrate(t, "");
  check(r.status === 0 && /pr create/.test(r.ghLog), "creates the PR", r.out);
}

rmSync(work, { recursive: true, force: true });
if (failures) {
  console.error(`\nintegrate existing-PR tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nintegrate existing-PR tests passed.");
