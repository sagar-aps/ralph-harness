import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

run(process.execPath, [cliPath, "--help"]);

const projectRoot = mkdtempSync(path.join(tmpdir(), "ralph-cli-"));
try {
  const outPath = path.join(projectRoot, "prd.json");
  run(process.execPath, [cliPath, "prd", "Smoke test PRD", "--out", outPath], {
    cwd: projectRoot,
    env: { ...process.env, RALPH_DRY_RUN: "1" },
  });

  if (!existsSync(outPath)) {
    console.error("PRD smoke test failed: output not created.");
    process.exit(1);
  }

  run(process.execPath, [cliPath, "overview", "--prd", outPath], {
    cwd: projectRoot,
    env: { ...process.env },
  });

  const overviewPath = outPath.replace(/\.json$/i, ".overview.md");
  if (!existsSync(overviewPath)) {
    console.error("Overview smoke test failed: output not created.");
    process.exit(1);
  }
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}

// install-agent-commands: claude / codex / copilot land in the right place,
// with the right extension and per-agent transform. Sandboxed via a fake HOME.
{
  const fakeHome = mkdtempSync(path.join(tmpdir(), "ralph-home-"));
  try {
    const env = { ...process.env, HOME: fakeHome, RALPH_SKIP_UPDATE_CHECK: "1" };
    for (const agent of ["claude", "codex", "copilot"]) {
      run(process.execPath, [cliPath, "install-agent-commands", "--agent", agent], { env });
    }
    const claude = path.join(fakeHome, ".claude", "commands", "ralph-review.md");
    const codex = path.join(fakeHome, ".codex", "prompts", "ralph-review.md");
    const copilot = path.join(fakeHome, ".config", "Code", "User", "prompts", "ralph-review.prompt.md");
    for (const [label, p] of [["claude", claude], ["codex", codex], ["copilot", copilot]]) {
      if (!existsSync(p)) {
        console.error(`install-agent-commands failed: missing ${label} file ${p}`);
        process.exit(1);
      }
    }
    // Codex variant strips the YAML frontmatter; Claude keeps it.
    if (readFileSync(codex, "utf-8").startsWith("---")) {
      console.error("install-agent-commands failed: codex prompt should not keep YAML frontmatter.");
      process.exit(1);
    }
    if (!readFileSync(claude, "utf-8").startsWith("---")) {
      console.error("install-agent-commands failed: claude command should keep frontmatter.");
      process.exit(1);
    }
    // Copilot variant uses ${input:args} and mode: agent.
    const cop = readFileSync(copilot, "utf-8");
    if (!cop.includes("${input:args}") || !cop.includes("mode: agent")) {
      console.error("install-agent-commands failed: copilot prompt missing input var / mode.");
      process.exit(1);
    }
    // Re-run without --force should skip existing files.
    const again = spawnSync(process.execPath, [cliPath, "install-agent-commands", "--agent", "claude"], {
      env,
      encoding: "utf-8",
    });
    if (!/Skipped \(already exist/.test(`${again.stdout}${again.stderr}`)) {
      console.error("install-agent-commands failed: expected existing files to be skipped.");
      process.exit(1);
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

console.log("CLI smoke test passed.");
