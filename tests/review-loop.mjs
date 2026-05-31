// Dry-run smoke test for the builder/reviewer review loop.
// Creates a tiny temporary target git repo with a PRD, runs `ralph review`
// in RALPH_DRY_RUN mode (no real agents), and verifies that:
//   - a worktree + branch are created (and main is untouched)
//   - the expected run artifacts are produced
//   - the loop stops at READY_FOR_HUMAN_REVIEW
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function fail(msg) {
  console.error(`Review-loop smoke test FAILED: ${msg}`);
  process.exit(1);
}

const target = mkdtempSync(path.join(tmpdir(), "ralph-target-"));
try {
  // Set up a minimal target git repo.
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "test@example.com"]);
  git(target, ["config", "user.name", "Ralph Test"]);
  writeFileSync(path.join(target, "README.md"), "# Target\n");
  mkdirSync(path.join(target, ".agents", "tasks"), { recursive: true });
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
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "initial"]);
  const mainHead = git(target, ["rev-parse", "HEAD"]);

  // Keep worktrees inside the temp dir so cleanup is contained.
  const wtDir = path.join(target, "..", `ralph-wt-${path.basename(target)}`);

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "review",
      "1",
      "--repo",
      target,
      "--builder",
      "opencode",
      "--reviewer",
      "claude",
      "--max-iterations",
      "2",
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        RALPH_DRY_RUN: "1",
        RALPH_SKIP_UPDATE_CHECK: "1",
        RALPH_WORKTREE_DIR: wtDir,
      },
    },
  );

  const out = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) fail(`exit ${result.status}\n${out}`);
  if (!out.includes("READY_FOR_HUMAN_REVIEW")) {
    fail(`expected READY_FOR_HUMAN_REVIEW in output:\n${out}`);
  }

  // Main branch HEAD must be unchanged (no auto-merge).
  if (git(target, ["rev-parse", "HEAD"]) !== mainHead) {
    fail("target main HEAD changed — must not happen");
  }

  // A ralph/* branch must exist.
  const branches = git(target, ["branch", "--list", "ralph/*"]);
  if (!branches.includes("ralph/")) fail(`expected a ralph/* branch, got: ${branches}`);

  // Artifacts must exist.
  const runsDir = path.join(target, ".ralph", "runs");
  if (!existsSync(runsDir)) fail("no .ralph/runs directory created");
  const runId = readdirSync(runsDir)[0];
  const runDir = path.join(runsDir, runId);
  const expected = [
    "task.md",
    "config.resolved.env",
    "builder_prompt_1.md",
    "check_1.log",
    "diff_1.patch",
    "reviewer_prompt_1.md",
    "reviewer_output_1.md",
    "final_status.md",
  ];
  for (const f of expected) {
    if (!existsSync(path.join(runDir, f))) fail(`missing artifact: ${f}`);
  }
  const finalStatus = readFileSync(path.join(runDir, "final_status.md"), "utf-8");
  if (!finalStatus.includes("READY_FOR_HUMAN_REVIEW")) {
    fail("final_status.md does not record READY_FOR_HUMAN_REVIEW");
  }

  // Clean up the worktree created during the run.
  try {
    rmSync(wtDir, { recursive: true, force: true });
    git(target, ["worktree", "prune"]);
  } catch {}

  console.log("Review-loop smoke test passed.");
} finally {
  rmSync(target, { recursive: true, force: true });
  try {
    rmSync(path.join(target, "..", `ralph-wt-${path.basename(target)}`), {
      recursive: true,
      force: true,
    });
  } catch {}
}
