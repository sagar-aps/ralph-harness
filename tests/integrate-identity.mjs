// Fixture tests for `ralph integrate --pr` identity (#71).
// The PR-filing path must resolve the identity via .agents/ralph/resolve-identity.sh
// (#53) and run BOTH writes — `git push` and `gh pr create` — UNDER the resolved
// wrapper, so the PR is authored by the App and not by ambient `gh` (the Owner).
// With nothing resolved it may fall back to ambient `gh`, but only LOUDLY.
//
// Hermetic: a stub wrapper and a stub `gh` on PATH; no real gh, no network, no secrets.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

let failures = 0;
// `detail` is printed only when the check fails, so a green run stays readable.
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
function writeExec(file, body) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}
function read(file) {
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

// A stub `gh`: records every invocation, reports no existing PR, and captures the
// --body of `pr create` so we can assert what the PR actually says.
const STUB_GH = `#!/usr/bin/env bash
{ printf 'gh'; printf ' %s' "$@"; printf '\\n'; } >> "$RALPH_TEST_GH_LOG"
if [[ "\${1:-}" == "--version" ]]; then echo "gh version 0.0.0 (stub)"; exit 0; fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "list" ]]; then exit 0; fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "create" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--body" ]]; then printf '%s' "\${2:-}" > "$RALPH_TEST_GH_BODY"; fi
    shift
  done
  echo "https://example.invalid/pull/1"
  exit 0
fi
exit 0
`;

// A stub identity wrapper with the real contract: `<wrapper> <role> <command…>`.
// It records the role + command it was handed, then actually runs the command
// (so the push/PR still happen, exactly as a real GH_TOKEN wrapper would).
const STUB_WRAPPER = `#!/usr/bin/env bash
{ printf 'wrapper'; printf ' %s' "$@"; printf '\\n'; } >> "$RALPH_TEST_WRAPPER_LOG"
role="\${1:-}"
shift || true
[[ -n "\${role}" ]] || { echo "wrapper: no role" >&2; exit 64; }
exec "$@"
`;

// A target repo with an origin (bare) and a finished, ready-for-review run.
function makeTarget({ targetConfig } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "ralph-identity-"));
  const origin = path.join(work, "origin.git");
  const target = path.join(work, "target");
  mkdirSync(origin);
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

  const branch = "issue-71-identity";
  git(target, ["checkout", "-qb", branch]);
  writeFileSync(path.join(target, "feature.txt"), "work\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-qm", "feature"]);
  git(target, ["checkout", "-q", "main"]);

  const runId = "20260810-000000-000000";
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  writeFileSync(
    path.join(target, ".ralph", "last-run.env"),
    [`RUN_ID=${runId}`, "STATUS=READY_FOR_HUMAN_REVIEW", `BRANCH=${branch}`, `TARGET_REPO=${target}`, ""].join("\n"),
  );
  if (targetConfig) {
    writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify(targetConfig, null, 2));
  }

  const bin = path.join(work, "bin");
  mkdirSync(bin);
  writeExec(path.join(bin, "gh"), STUB_GH);
  const wrapper = path.join(work, "wrapper.sh");
  writeExec(wrapper, STUB_WRAPPER);

  return {
    work,
    target,
    branch,
    runId,
    wrapper,
    bin,
    ghLog: path.join(work, "gh.log"),
    ghBody: path.join(work, "pr-body.txt"),
    wrapperLog: path.join(work, "wrapper.log"),
  };
}

function integratePr(t, extraEnv = {}) {
  const env = { ...process.env };
  // These decide the outcome under test — never inherit them from the operator shell.
  delete env.RALPH_IDENTITY_WRAPPER;
  delete env.RALPH_IN_PREFLIGHT;
  return spawnSync(process.execPath, [cliPath, "integrate", "--repo", t.target, "--pr", "--keep-worktree"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...env,
      PATH: `${t.bin}:${process.env.PATH}`,
      RALPH_SKIP_UPDATE_CHECK: "1",
      RALPH_NO_LOCAL_CONFIG: "1",
      RALPH_TEST_GH_LOG: t.ghLog,
      RALPH_TEST_GH_BODY: t.ghBody,
      RALPH_TEST_WRAPPER_LOG: t.wrapperLog,
      ...extraEnv,
    },
  });
}

console.log("integrate --pr identity (#71)");

// 1) $RALPH_IDENTITY_WRAPPER resolves -> both writes run UNDER the wrapper.
{
  console.log("\n1) resolved via $RALPH_IDENTITY_WRAPPER");
  const t = makeTarget();
  const r = integratePr(t, { RALPH_IDENTITY_WRAPPER: t.wrapper });
  const wrapperLog = read(t.wrapperLog);
  const body = read(t.ghBody);
  check(r.status === 0, "exit 0", `${r.status}\n${r.stdout}\n${r.stderr}`);
  check(
    /^wrapper orchestrator git .*push -u origin issue-71-identity$/m.test(wrapperLog),
    "git push ran under the wrapper with the role", wrapperLog,
  );
  check(
    /^wrapper orchestrator gh pr create /m.test(wrapperLog),
    "gh pr create ran under the wrapper with the role", wrapperLog,
  );
  check(/gh pr create /.test(read(t.ghLog)), "the wrapper really executed `gh pr create`");
  check(!/DEGRADED/.test(body), "PR body carries no degraded notice when the identity resolved");
  check(/Identity: resolved wrapper /.test(body), "PR body states the resolved identity");
  check(!/DEGRADED MODE/.test(r.stderr), "stderr carries no degraded notice when the identity resolved");
  check(
    git(t.target, ["ls-remote", "origin", t.branch]).includes(t.branch),
    "the branch reached origin (the push really happened)",
  );
}

// 2) ralph.target.json marker resolves -> wrapper + the marker's role.
{
  console.log("\n2) resolved via the ralph.target.json marker (marker role is used)");
  const t = makeTarget();
  // The marker's wrapper is this target's stub; $RALPH_IDENTITY_WRAPPER points at a
  // DIFFERENT (also valid) wrapper, so the recorded role tells us which one won.
  const envWrapper = path.join(t.work, "env-wrapper.sh");
  writeExec(envWrapper, STUB_WRAPPER);
  writeFileSync(
    path.join(t.target, "ralph.target.json"),
    JSON.stringify({ check: "true", identity: { enabled: true, wrapper: t.wrapper, role: "bot-account" } }, null, 2),
  );
  const r = integratePr(t, { RALPH_IDENTITY_WRAPPER: envWrapper });
  const wrapperLog = read(t.wrapperLog);
  check(r.status === 0, "exit 0", `${r.status}\n${r.stdout}\n${r.stderr}`);
  check(
    /^wrapper bot-account git .*push -u origin issue-71-identity$/m.test(wrapperLog),
    "git push ran under the marker wrapper with the marker role", wrapperLog,
  );
  check(
    /^wrapper bot-account gh pr create /m.test(wrapperLog),
    "gh pr create ran under the marker wrapper with the marker role", wrapperLog,
  );
  check(
    !/^wrapper orchestrator /m.test(wrapperLog),
    "the marker wins over $RALPH_IDENTITY_WRAPPER (no default-role invocation)",
  );
}

// 3) Marker enabled but unresolvable -> ambient gh, LOUDLY (degraded).
{
  console.log("\n3) marker enabled + unresolvable wrapper -> loud DEGRADED, ambient gh");
  const t = makeTarget({
    targetConfig: { check: "true", identity: { enabled: true, wrapper: "/nonexistent/wrapper.sh", role: "orchestrator" } },
  });
  const r = integratePr(t);
  const body = read(t.ghBody);
  check(r.status === 0, "exit 0", `${r.status}\n${r.stdout}\n${r.stderr}`);
  check(read(t.wrapperLog) === "", "no wrapper was invoked (nothing resolved)");
  check(/gh pr create /.test(read(t.ghLog)), "the PR was still filed via ambient gh");
  check(/DEGRADED MODE/.test(r.stderr), "stderr carries the loud degraded notice", r.stderr);
  check(/DEGRADED MODE/.test(body), "PR body carries the loud degraded notice", body);
  check(/identity wrapper failed to resolve/.test(body), "the body says the wrapper failed to resolve");
}

// 4) Nothing configured -> ambient gh, still never silent.
{
  console.log("\n4) no marker, no wrapper -> ambient gh with a loud notice (never silent)");
  const t = makeTarget();
  const r = integratePr(t);
  const body = read(t.ghBody);
  check(r.status === 0, "exit 0", `${r.status}\n${r.stdout}\n${r.stderr}`);
  check(read(t.wrapperLog) === "", "no wrapper was invoked (nothing resolved)");
  check(/gh pr create /.test(read(t.ghLog)), "the PR was still filed via ambient gh");
  check(/DEGRADED MODE/.test(r.stderr), "stderr carries the loud notice", r.stderr);
  check(/no identity wrapper resolved/.test(body), "PR body names the ambient-gh fallback", body);
}

if (failures) {
  console.error(`\nintegrate-identity: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nintegrate-identity: all checks passed");
