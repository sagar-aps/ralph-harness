import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "bin", "ralph");
const loopPath = path.join(repoRoot, ".agents", "ralph", "loop.sh");

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function commandExists(cmd) {
  const result = spawnSync(`command -v ${cmd}`, { shell: true, stdio: "ignore" });
  return result.status === 0;
}

function isolatedEnv(overrides = {}) {
  return {
    ...process.env,
    TARGET_REPO: "",
    BUILDER: "",
    REVIEWER: "",
    STORY_ID: "",
    STORY_TITLE: "",
    STORY_BLOCK: "",
    RALPH_RUN_ID: "",
    RALPH_TARGET_REPO: "",
    RALPH_BRANCH: "",
    RALPH_WORKTREE: "",
    RALPH_BASE_COMMIT: "",
    ...overrides,
  };
}

function setupTempProject() {
  const base = mkdtempSync(path.join(tmpdir(), "ralph-smoke-"));
  mkdirSync(path.join(base, ".agents", "tasks"), { recursive: true });
  mkdirSync(path.join(base, ".ralph"), { recursive: true });
  const prd = {
    version: 1,
    project: "Smoke Test",
    qualityGates: [],
    stories: [
      {
        id: "US-001",
        title: "Smoke Test Story",
        status: "open",
        dependsOn: [],
        acceptanceCriteria: [
          "Example: input -> output",
          "Negative case: bad input -> error",
        ],
      },
    ],
  };
  writeFileSync(
    path.join(base, ".agents", "tasks", "prd.json"),
    `${JSON.stringify(prd, null, 2)}\n`,
  );
  return base;
}

const agents = ["codex", "claude", "droid"];
const integration = process.env.RALPH_INTEGRATION === "1";

for (const agent of agents) {
  const projectRoot = setupTempProject();
  try {
    const env = isolatedEnv({ RALPH_NO_LOCAL_CONFIG: "1" });
    if (!integration) {
      env.RALPH_DRY_RUN = "1";
    } else if (agent === "codex" && !commandExists("codex")) {
      console.log(`Skipping codex integration test (missing codex).`);
      continue;
    } else if (agent === "claude" && !commandExists("claude")) {
      console.log(`Skipping claude integration test (missing claude).`);
      continue;
    } else if (agent === "droid" && !commandExists("droid")) {
      console.log(`Skipping droid integration test (missing droid).`);
      continue;
    }

    run(process.execPath, [cliPath, "build", "1", "--no-commit", `--agent=${agent}`], {
      cwd: projectRoot,
      env,
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

// Regression for issue #37: run the actual loop with a prompt too large to fit
// safely in one argv entry. The stub must receive the complete rendered prompt
// through stdin; no real provider is called.
{
  const projectRoot = setupTempProject();
  const stubDir = mkdtempSync(path.join(tmpdir(), "ralph-claude-stub-"));
  const capture = path.join(stubDir, "stdin.txt");
  const marker = `LARGE_PROMPT_END_${"z".repeat(64)}`;
  try {
    writeFileSync(path.join(projectRoot, "AGENTS.md"), "# Test agent instructions\n");
    writeFileSync(
      path.join(projectRoot, ".agents", "tasks", "prd.json"),
      `${JSON.stringify({
        version: 1,
        project: "Large Prompt Test",
        qualityGates: [],
        stories: [{
          id: "US-LARGE",
          title: "Receive a large prompt",
          status: "open",
          dependsOn: [],
          acceptanceCriteria: [`${"x".repeat(220 * 1024)}\n${marker}`],
        }],
      })}\n`,
    );
    const stub = path.join(stubDir, "claude");
    writeFileSync(stub, `#!/usr/bin/env bash
cat > "$CLAUDE_STDIN_CAPTURE"
printf '%s\\n' '<promise>COMPLETE</promise>'
`);
    chmodSync(stub, 0o755);
    run(loopPath, ["build", "1", "--no-commit"], {
      cwd: projectRoot,
      env: isolatedEnv({
        AGENT_CMD: "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL claude -p --dangerously-skip-permissions",
        AGENTS_PATH: path.join(projectRoot, "AGENTS.md"),
        RALPH_NO_LOCAL_CONFIG: "1",
        RALPH_ROOT: projectRoot,
        PRD_PATH: path.join(projectRoot, ".agents", "tasks", "prd.json"),
        PROMPT_BUILD: path.join(repoRoot, ".agents", "ralph", "PROMPT_build.md"),
        GUARDRAILS_REF: path.join(repoRoot, ".agents", "ralph", "references", "GUARDRAILS.md"),
        CONTEXT_REF: path.join(repoRoot, ".agents", "ralph", "references", "CONTEXT_ENGINEERING.md"),
        PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAUDE_STDIN_CAPTURE: capture,
      }),
    });
    const received = readFileSync(capture, "utf-8");
    if (received.length < 200 * 1024 || !received.includes(marker)) {
      console.error(`Claude stdin regression failed: received ${received.length} bytes without the full marker`);
      process.exit(1);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
}

console.log("Agent loop smoke tests passed.");
