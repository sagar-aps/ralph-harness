// Smoke tests for the builder/reviewer review loop + preview lifecycle + operator
// commands (status/integrate/cleanup). Uses RALPH_DRY_RUN=1 so no real agents run;
// the deterministic stages (check, preview-up/url/e2e, preview-down) DO run, driven
// by dummy shell scripts in a temporary target git repo.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ✔ ${msg}`);
  } else {
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

function writeScript(file, body) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

// Create a target git repo. opts.preview adds preview scripts + config.
function makeTarget(opts = {}) {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-target-"));
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "test@example.com"]);
  git(target, ["config", "user.name", "Ralph Test"]);
  writeFileSync(path.join(target, "README.md"), "# Target\n");
  mkdirSync(path.join(target, ".agents", "tasks"), { recursive: true });
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  writeScript(path.join(target, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const prd = {
    version: 1,
    project: "Target App",
    qualityGates: [],
    stories: [
      {
        id: "US-001",
        title: "Add a greeting line",
        status: "open",
        dependsOn: [],
        acceptanceCriteria: ["README.md contains a greeting line"],
      },
    ],
  };
  writeFileSync(
    path.join(target, ".agents", "tasks", "prd.json"),
    `${JSON.stringify(prd, null, 2)}\n`,
  );

  const cfg = { check: "./scripts/check.sh", preview: { enabled: false } };
  if (opts.preview) {
    writeScript(
      path.join(target, "scripts", "preview-up.sh"),
      "#!/usr/bin/env bash\necho PREVIEW_UP_TOKEN app=$RALPH_APP_PORT db=$RALPH_DB_PORT proj=$RALPH_COMPOSE_PROJECT\nexit 0\n",
    );
    writeScript(
      path.join(target, "scripts", "preview-url.sh"),
      "#!/usr/bin/env bash\necho http://apps:${RALPH_APP_PORT}\n",
    );
    writeScript(
      path.join(target, "scripts", "preview-down.sh"),
      "#!/usr/bin/env bash\necho PREVIEW_DOWN_TOKEN\nexit 0\n",
    );
    const e2eBody = opts.e2eFails
      ? "#!/usr/bin/env bash\necho E2E_FAIL_TOKEN url=$RALPH_PREVIEW_URL\nexit 1\n"
      : "#!/usr/bin/env bash\necho E2E_PASS_TOKEN url=$RALPH_PREVIEW_URL\nexit 0\n";
    writeScript(path.join(target, "scripts", "e2e.sh"), e2eBody);
    cfg.preview = {
      enabled: true,
      up: "./scripts/preview-up.sh",
      down: "./scripts/preview-down.sh",
      url: "./scripts/preview-url.sh",
      e2e: "./scripts/e2e.sh",
      host: "apps",
      keepOnPass: true,
      keepOnFail: false,
    };
  }
  writeFileSync(path.join(target, "ralph.target.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-handoff.md\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  return { target, mainHead: git(target, ["rev-parse", "HEAD"]) };
}

function wtDirFor(target) {
  return path.join(target, "..", `ralph-wt-${path.basename(target)}`);
}
function cleanupTarget(target) {
  const wt = wtDirFor(target);
  try {
    rmSync(wt, { recursive: true, force: true });
  } catch {}
  rmSync(target, { recursive: true, force: true });
}
function latestRunDir(target) {
  const runs = path.join(target, ".ralph", "runs");
  const d = readdirSync(runs).sort();
  return path.join(runs, d[d.length - 1]);
}

// ---------------------------------------------------------------------------
console.log("1) Review loop WITHOUT preview");
{
  const { target, mainHead } = makeTarget();
  try {
    const r = ralph(
      ["review", "1", "--repo", target, "--builder", "opencode", "--reviewer", "claude", "--max-iterations", "2"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtDirFor(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, "exits 0");
    check(out.includes("READY_FOR_HUMAN_REVIEW"), "reaches READY_FOR_HUMAN_REVIEW");
    check(git(target, ["rev-parse", "HEAD"]) === mainHead, "target main HEAD unchanged (no auto-merge)");
    check(git(target, ["branch", "--list", "ralph/*"]).includes("ralph/"), "ralph/* branch created");
    const runDir = latestRunDir(target);
    for (const f of [
      "task.md",
      "config.resolved.env",
      "builder_prompt_1.md",
      "check_1.log",
      "diff_1.patch",
      "reviewer_prompt_1.md",
      "reviewer_output_1.md",
      "final_status.md",
    ]) {
      check(existsSync(path.join(runDir, f)), `artifact ${f} exists`);
    }
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    check(/STATUS=READY_FOR_HUMAN_REVIEW/.test(lastRun), "last-run.env records READY status");
    check(!existsSync(path.join(runDir, "preview_up_1.log")), "no preview artifacts when preview disabled");
  } finally {
    cleanupTarget(target);
  }
}

// ---------------------------------------------------------------------------
console.log("2) Review loop WITH preview (passing e2e)");
{
  const { target } = makeTarget({ preview: true });
  try {
    const r = ralph(
      ["review", "1", "--repo", target, "--builder", "opencode", "--reviewer", "claude", "--max-iterations", "2"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtDirFor(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, "exits 0");
    check(out.includes("READY_FOR_HUMAN_REVIEW"), "reaches READY_FOR_HUMAN_REVIEW");
    const runDir = latestRunDir(target);
    check(existsSync(path.join(runDir, "preview_up_1.log")), "preview_up_1.log recorded");
    check(existsSync(path.join(runDir, "preview_url_1.txt")), "preview_url_1.txt recorded");
    check(existsSync(path.join(runDir, "e2e_1.log")), "e2e_1.log recorded");
    const url = readFileSync(path.join(runDir, "preview_url_1.txt"), "utf-8").trim();
    check(/^http:\/\/apps:\d+$/.test(url), `preview URL resolved from script (${url})`);
    const cfgEnv = readFileSync(path.join(runDir, "config.resolved.env"), "utf-8");
    check(/PREVIEW_ENABLED=true/.test(cfgEnv), "config.resolved.env shows preview enabled");
    check(/RALPH_APP_PORT=\d+/.test(cfgEnv), "an app port was allocated");
    check(out.includes("Preview:"), "terminal summary prints preview URL");
  } finally {
    cleanupTarget(target);
  }
}

// ---------------------------------------------------------------------------
console.log("3) Failing e2e routes its log back into the next builder prompt");
{
  const { target } = makeTarget({ preview: true, e2eFails: true });
  try {
    const r = ralph(
      ["review", "1", "--repo", target, "--reviewer", "claude", "--builder", "opencode", "--max-iterations", "2"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtDirFor(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 2, "exits 2 (FAILED_MAX_ITERATIONS)");
    check(out.includes("FAILED_MAX_ITERATIONS"), "reports FAILED_MAX_ITERATIONS");
    const runDir = latestRunDir(target);
    const builder2 = readFileSync(path.join(runDir, "builder_prompt_2.md"), "utf-8");
    check(builder2.includes("E2E_FAIL_TOKEN"), "iteration 2 builder prompt includes the failing e2e log");
  } finally {
    cleanupTarget(target);
  }
}

// ---------------------------------------------------------------------------
console.log("4) ralph status reads latest run metadata");
{
  const { target } = makeTarget();
  try {
    ralph(["review", "1", "--repo", target, "--max-iterations", "1"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtDirFor(target),
    });
    const r = ralph(["status", "--repo", target]);
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, "status exits 0");
    check(/Status:\s+READY_FOR_HUMAN_REVIEW/.test(out), "status shows READY_FOR_HUMAN_REVIEW");
    check(/Branch:\s+ralph\//.test(out), "status shows the run branch");
  } finally {
    cleanupTarget(target);
  }
}

// ---------------------------------------------------------------------------
console.log("5) ralph integrate refuses unless READY (then integrates on success)");
{
  // Refusal: fabricate a non-ready last-run.env.
  const { target } = makeTarget();
  try {
    ralph(["review", "1", "--repo", target, "--max-iterations", "1"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtDirFor(target),
    });
    const lastRunPath = path.join(target, ".ralph", "last-run.env");
    const orig = readFileSync(lastRunPath, "utf-8");
    writeFileSync(lastRunPath, orig.replace("STATUS=READY_FOR_HUMAN_REVIEW", "STATUS=FAILED_MAX_ITERATIONS"));
    const refuse = ralph(["integrate", "--repo", target]);
    check(refuse.status !== 0, "integrate refuses when status != READY");
    check(/not READY_FOR_HUMAN_REVIEW/.test(`${refuse.stdout}${refuse.stderr}`), "refusal explains why");

    // Success: restore READY and integrate.
    writeFileSync(lastRunPath, orig);
    const mainBefore = git(target, ["rev-parse", "HEAD"]);
    const ok = ralph(["integrate", "--repo", target]);
    const out = `${ok.stdout}${ok.stderr}`;
    check(ok.status === 0, "integrate exits 0 on a READY run");
    check(out.includes("Merge complete"), "performs a merge");
    check(out.includes("Post-merge check passed"), "re-runs the check after merge");
    check(git(target, ["rev-parse", "HEAD"]) !== mainBefore, "target branch advanced by the merge");
    check(/Push when ready/.test(out), "tells user to push manually (never auto-pushes)");
  } finally {
    cleanupTarget(target);
  }
}

// ---------------------------------------------------------------------------
console.log("6) ralph cleanup removes worktree and handles a missing one");
{
  const { target } = makeTarget({ preview: true });
  try {
    ralph(["review", "1", "--repo", target, "--max-iterations", "1"], {
      RALPH_DRY_RUN: "1",
      RALPH_WORKTREE_DIR: wtDirFor(target),
    });
    const lastRun = readFileSync(path.join(target, ".ralph", "last-run.env"), "utf-8");
    const wt = lastRun.match(/WORKTREE=(.*)/)[1].trim();
    check(existsSync(wt), "worktree exists before cleanup");
    const c1 = ralph(["cleanup", "--repo", target]);
    const out1 = `${c1.stdout}${c1.stderr}`;
    check(c1.status === 0, "cleanup exits 0");
    check(out1.includes("removed worktree"), "cleanup reports removing the worktree");
    check(out1.includes("kept (use --delete-branch"), "cleanup keeps the branch by default");
    check(!existsSync(wt), "worktree is gone after cleanup");
    // Run again: worktree already gone -> graceful.
    const c2 = ralph(["cleanup", "--repo", target]);
    check(c2.status === 0, "second cleanup exits 0 (missing worktree handled gracefully)");
    check(/no worktree to remove/.test(`${c2.stdout}${c2.stderr}`), "reports nothing to remove");
  } finally {
    cleanupTarget(target);
  }
}

if (failures) {
  console.error(`\nReview-loop smoke tests FAILED (${failures} assertion failure(s)).`);
  process.exit(1);
}
console.log("\nReview-loop smoke tests passed.");
