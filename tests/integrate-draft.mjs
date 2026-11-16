#!/usr/bin/env node
// `ralph integrate --pr` draft-first mode (CI cost, Memorix #1189): a draft PR runs only
// the light CI jobs, so open builder PRs as drafts, mark them ready once the local gate
// passed (--ready), and never push a change that leaves the PR head's tree unchanged.
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

// Stub gh: `pr list` reports a PR in $RALPH_TEST_PR_STATE (none when unset), draft when
// $RALPH_TEST_PR_DRAFT=true. Every call is logged.
const STUB_GH = `#!/usr/bin/env bash
{ printf 'gh'; printf ' %s' "$@"; printf '\\n'; } >> "$RALPH_TEST_GH_LOG"
if [[ "\${1:-}" == "--version" ]]; then echo "gh version 0.0.0 (stub)"; exit 0; fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then
  [[ -n "\${RALPH_TEST_PR_STATE:-}" ]] && printf '{"url":"https://example.invalid/pull/7","state":"%s","isDraft":%s}\\n' "$RALPH_TEST_PR_STATE" "\${RALPH_TEST_PR_DRAFT:-false}"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "create" ]]; then echo "https://example.invalid/pull/8"; exit 0; fi
exit 0
`;

const work = mkdtempSync(path.join(tmpdir(), "ralph-draft-pr-"));
let n = 0;
// pushed: whether the PR branch already exists on origin. sameTree: the run's new commit
// rewrites the pushed one without changing its tree (a no-op rebase/reword).
function makeTarget({ pushed = true, sameTree = false, draftConfig } = {}) {
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
  if (draftConfig !== undefined) writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify({ pr: { draft: draftConfig } }));
  git(target, ["add", "-A"]);
  git(target, ["commit", "-qm", "base"]);
  git(target, ["remote", "add", "origin", origin]);
  git(target, ["push", "-qu", "origin", "main"]);

  const branch = "issue-1189-x";
  git(target, ["checkout", "-qb", branch]);
  writeFileSync(path.join(target, "a.txt"), "round 1\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-qm", "round 1"]);
  if (pushed) git(target, ["push", "-q", "origin", branch]);
  if (sameTree) git(target, ["commit", "-q", "--amend", "-m", "round 1 (reworded)"]);
  else if (pushed) {
    writeFileSync(path.join(target, "a.txt"), "round 2\n");
    git(target, ["commit", "-qam", "round 2"]);
  }
  git(target, ["checkout", "-q", "main"]);

  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  writeFileSync(
    path.join(target, ".ralph", "last-run.env"),
    ["RUN_ID=20261117-000000-000000", "STATUS=READY_FOR_HUMAN_REVIEW", `BRANCH=${branch}`, `TARGET_REPO=${target}`, ""].join("\n"),
  );
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), STUB_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  return { target, origin, branch, bin, ghLog: path.join(dir, "gh.log") };
}
function integrate(t, { state = "", draft = false, args = [] } = {}) {
  const env = { ...process.env };
  delete env.RALPH_IDENTITY_WRAPPER;
  delete env.RALPH_IN_PREFLIGHT;
  const r = spawnSync(process.execPath, [cliPath, "integrate", "--repo", t.target, "--pr", "--keep-worktree", ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...env,
      PATH: `${t.bin}:${process.env.PATH}`,
      RALPH_SKIP_UPDATE_CHECK: "1",
      RALPH_NO_LOCAL_CONFIG: "1",
      RALPH_TEST_GH_LOG: t.ghLog,
      RALPH_TEST_PR_STATE: state,
      RALPH_TEST_PR_DRAFT: String(draft),
    },
  });
  const ghLog = existsSync(t.ghLog) ? readFileSync(t.ghLog, "utf-8") : "";
  const remoteTip = spawnSync("git", ["rev-parse", "-q", "--verify", t.branch], { cwd: t.origin, encoding: "utf-8" }).stdout.trim();
  const localTip = git(t.target, ["rev-parse", t.branch]);
  // The create call spans several log lines (multi-line --body): take it up to the next gh call.
  const at = ghLog.indexOf("gh pr create");
  const createLine = at < 0 ? "" : ghLog.slice(at).split(/\ngh /)[0];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, ghLog, remoteTip, localTip, createLine };
}

console.log('A) no PR yet, ralph.target.json "pr": {"draft": true} -> created as a draft');
{
  const r = integrate(makeTarget({ pushed: false, draftConfig: true }));
  check(r.status === 0 && / --draft\b/.test(r.createLine), "gh pr create ... --draft", r.out + r.ghLog);
}

console.log("B) no PR, no config -> created ready (unchanged default)");
{
  const r = integrate(makeTarget({ pushed: false }));
  check(r.status === 0 && r.createLine && !/--draft/.test(r.createLine), "gh pr create without --draft", r.out + r.ghLog);
}

console.log("C) --draft flag without config -> draft; --no-draft overrides the config");
{
  const a = integrate(makeTarget({ pushed: false }), { args: ["--draft"] });
  check(/ --draft\b/.test(a.createLine), "--draft opens a draft", a.out);
  const b = integrate(makeTarget({ pushed: false, draftConfig: true }), { args: ["--no-draft"] });
  check(b.createLine && !/--draft/.test(b.createLine), "--no-draft beats the config", b.out);
}

console.log("D) draft config + --ready (local gate passed) -> created ready, never draft-then-ready");
{
  const r = integrate(makeTarget({ pushed: false, draftConfig: true }), { args: ["--ready"] });
  check(r.status === 0 && r.createLine && !/--draft/.test(r.createLine), "created without --draft", r.out);
  check(!/pr ready/.test(r.ghLog), "no separate gh pr ready call (one CI run, not two)");
}

console.log("E) open DRAFT PR + --ready -> push the reviewfix, then gh pr ready");
{
  const t = makeTarget({ draftConfig: true });
  const r = integrate(t, { state: "OPEN", draft: true, args: ["--ready"] });
  check(r.status === 0 && r.remoteTip === r.localTip, "the commit reached the PR branch", r.out);
  check(/gh pr ready https:\/\/example\.invalid\/pull\/7\n/.test(r.ghLog), "gh pr ready <url> was called", r.ghLog);
  check(!/--undo/.test(r.ghLog), "not converted to draft");
}

console.log("F) open READY PR, draft mode, intermediate reviewfix push -> back to draft first");
{
  const t = makeTarget({ draftConfig: true });
  const r = integrate(t, { state: "OPEN", draft: false });
  check(r.status === 0 && r.remoteTip === r.localTip, "the commit reached the PR branch", r.out);
  check(/gh pr ready --undo https:\/\/example\.invalid\/pull\/7/.test(r.ghLog), "gh pr ready --undo before the push", r.ghLog);
}

console.log("G) open PR, run's tree == PR head's tree (no-op rebase/reword) -> nothing pushed");
{
  const t = makeTarget({ sameTree: true });
  const before = git(t.origin, ["rev-parse", t.branch]);
  const r = integrate(t, { state: "OPEN", draft: true, args: ["--ready"] });
  check(r.status === 0 && /nothing pushed/.test(r.out), "exits 0 and says nothing was pushed", r.out);
  check(r.remoteTip === before, "the PR head did not move (no CI re-run)");
  check(/gh pr ready https/.test(r.ghLog), "--ready still readies the draft");
}

rmSync(work, { recursive: true, force: true });
if (failures) {
  console.error(`\nintegrate draft-PR tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nintegrate draft-PR tests passed.");
