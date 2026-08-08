// Tests for normalized {provider, model, effort} agent selection (#4).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");
const agentsSh = path.join(repoRoot, ".agents", "ralph", "agents.sh");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
};

// Source agents.sh, apply env, run the resolver, and print the resolved values.
// strip_autoapprove is redefined here identically to batch-loop.sh so we can prove
// the review command is read-only after stripping.
function resolve(env) {
  const script = `
    set -uo pipefail
    strip_autoapprove(){ sed -E 's/ --dangerously-skip-permissions//g; s/ --skip-permissions-unsafe//g; s/ --yolo//g'; }
    source ${JSON.stringify(agentsSh)}
    ralph_resolve_role_agents
    echo "STATUS=$?"
    echo "BUILDER=\${BUILDER:-<unset>}"
    echo "REVIEWER=\${REVIEWER:-<unset>}"
    echo "BUILD=\${AGENT_RALPH_BUILD_CMD:-<unset>}"
    echo "REVIEW=\${AGENT_RALPH_REVIEW_CMD:-<unset>}"
    echo "REVIEW_STRIPPED=$(printf '%s' "\${AGENT_RALPH_REVIEW_CMD:-}" | strip_autoapprove)"
    echo "CLAUDE=\${AGENT_CLAUDE_CMD}"
    echo "OPENCODE=\${AGENT_OPENCODE_CMD}"
  `;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: { ...process.env, ...env } });
  const out = `${r.stdout}${r.stderr}`;
  const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1] ?? "";
  return { status: Number(get("STATUS")), BUILDER: get("BUILDER"), REVIEWER: get("REVIEWER"), BUILD: get("BUILD"), REVIEW: get("REVIEW"), REVIEW_STRIPPED: get("REVIEW_STRIPPED"), CLAUDE: get("CLAUDE"), OPENCODE: get("OPENCODE"), raw: out };
}

const claudeEnvUnsetPrefix = "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL claude";

console.log("1) resolution (no quota): presets and explicit knobs compose the right commands");
{
  const cheap = resolve({ RALPH_PROFILE: "cheap", BUILDER_PROVIDER: "", REVIEWER_PROVIDER: "", BUILDER_MODEL: "", REVIEWER_MODEL: "", BUILDER_EFFORT: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  check(cheap.BUILDER === "ralph-build" && cheap.REVIEWER === "ralph-review", "profile points roles at synthetic backends");
  check(cheap.BUILD === "codex exec --yolo --skip-git-repo-check -c model_reasoning_effort=low -", "cheap builder = codex low, stdin '-'");
  check(cheap.REVIEW === "codex exec --sandbox read-only -c model_reasoning_effort=low -", "cheap reviewer = codex read-only low");

  const hi = resolve({ BUILDER_PROVIDER: "codex", BUILDER_EFFORT: "high", REVIEWER_PROVIDER: "", REVIEWER_EFFORT: "", RALPH_PROFILE: "", BUILDER_MODEL: "", REVIEWER_MODEL: "", BUILDER: "", REVIEWER: "" });
  check(hi.BUILD === "codex exec --yolo --skip-git-repo-check -c model_reasoning_effort=high -", "explicit codex/high builder");

  const cl = resolve({ BUILDER_PROVIDER: "claude", BUILDER_MODEL: "sonnet", RALPH_PROFILE: "", REVIEWER_PROVIDER: "", BUILDER_EFFORT: "", REVIEWER_MODEL: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  check(cl.BUILD === `${claudeEnvUnsetPrefix} --model sonnet -p --dangerously-skip-permissions`, "claude builder clears inherited provider env and uses --model + stdin");

  const oc = resolve({ BUILDER_PROVIDER: "opencode", BUILDER_MODEL: "openai/gpt-5", RALPH_PROFILE: "", REVIEWER_PROVIDER: "", BUILDER_EFFORT: "", REVIEWER_MODEL: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  check(oc.OPENCODE === 'opencode run "$(cat {prompt})"' && oc.BUILD === 'opencode run --model openai/gpt-5 "$(cat {prompt})"', "shipped and normalized opencode commands use argv (opencode has no stdin path, #44)");
  check(!cl.CLAUDE.includes("{prompt}") && !cl.BUILD.includes("{prompt}"), "claude/codex stdin backends contain no {prompt} argv interpolation");
  check(oc.OPENCODE.includes("{prompt}") && oc.BUILD.includes("{prompt}"), "opencode (argv-only) DOES interpolate {prompt} — it cannot read stdin (#44)");
}

console.log("2) invariants: reviewer read-only after strip_autoapprove; require_backend sees a real binary first");
{
  const cl = resolve({ REVIEWER_PROVIDER: "claude", BUILDER_PROVIDER: "claude", RALPH_PROFILE: "", BUILDER_MODEL: "", REVIEWER_MODEL: "", BUILDER_EFFORT: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  check(!/--dangerously-skip-permissions/.test(cl.REVIEW_STRIPPED), "claude reviewer loses --dangerously-skip-permissions (read-only)");
  const mx = resolve({ RALPH_PROFILE: "max", BUILDER_PROVIDER: "", REVIEWER_PROVIDER: "", BUILDER_MODEL: "", REVIEWER_MODEL: "", BUILDER_EFFORT: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  check(mx.BUILD.split(" ")[0] === "codex" && mx.REVIEW.split(" ")[0] === "codex", "first token is the binary (codex) for require_backend");
  check(/--sandbox read-only/.test(mx.REVIEW), "codex reviewer is sandboxed read-only");
}

console.log("2b) Z.AI composer: hermetic env, arbitrary model passthrough, and read-only reviewer");
{
  const z = resolve({
    BUILDER_PROVIDER: "zai", BUILDER_MODEL: "glm-5.2", BUILDER_EFFORT: "high",
    REVIEWER_PROVIDER: "zlaude", REVIEWER_MODEL: "glm-4.5-air", REVIEWER_EFFORT: "low",
    RALPH_PROFILE: "", BUILDER: "", REVIEWER: "",
  });
  const zaiPrefix = 'env -u ANTHROPIC_API_KEY -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_BASE_URL="${RALPH_ZAI_BASE_URL:-https://api.z.ai/api/anthropic}" ANTHROPIC_AUTH_TOKEN="${RALPH_ZAI_AUTH_TOKEN:-}" claude -p';
  check(z.BUILD === `${zaiPrefix} --dangerously-skip-permissions --model glm-5.2`, "zai builder composes hermetic runtime env and passes its model by name");
  check(z.REVIEW_STRIPPED === `${zaiPrefix} --model glm-4.5-air`, "zlaude alias reviewer passes its model and has no permission-skip flag");
  check(!z.BUILD.includes("ANTHROPIC_API_KEY=") && z.BUILD.includes("env -u ANTHROPIC_API_KEY"), "zai fully unsets ANTHROPIC_API_KEY instead of assigning it empty");
  check(!z.BUILD.includes("model_reasoning_effort") && !z.REVIEW.includes("model_reasoning_effort"), "zai ignores effort");
  for (const model of ["glm-4.7", "glm-4.5-air", "glm-5.1", "glm-5.2"]) {
    const named = resolve({ BUILDER_PROVIDER: "zai", BUILDER_MODEL: model, RALPH_PROFILE: "", REVIEWER_PROVIDER: "", BUILDER_EFFORT: "", REVIEWER_MODEL: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
    check(named.BUILD.endsWith(` --model ${model}`), `zai passes arbitrary plan model ${model} directly to claude`);
  }

  const fixture = mkdtempSync(path.join(tmpdir(), "ralph-zai-env-"));
  const stub = path.join(fixture, "claude");
  writeFileSync(stub, `#!/usr/bin/env bash
printf 'API_KEY=%s\\n' "\${ANTHROPIC_API_KEY-unset}"
printf 'BASE=%s\\n' "\${ANTHROPIC_BASE_URL-unset}"
printf 'TOKEN=%s\\n' "\${ANTHROPIC_AUTH_TOKEN-unset}"
printf 'PINS=%s,%s,%s\\n' "\${ANTHROPIC_DEFAULT_SONNET_MODEL-unset}" "\${ANTHROPIC_DEFAULT_HAIKU_MODEL-unset}" "\${ANTHROPIC_DEFAULT_OPUS_MODEL-unset}"
printf 'ARGS=%s\\n' "$*"
read -r prompt
printf 'STDIN=%s\\n' "$prompt"
`);
  chmodSync(stub, 0o755);
  const run = spawnSync("bash", ["-c", z.REVIEW_STRIPPED], {
    encoding: "utf-8",
    input: "fixture prompt\n",
    env: {
      ...process.env,
      PATH: `${fixture}${path.delimiter}${process.env.PATH ?? ""}`,
      RALPH_ZAI_AUTH_TOKEN: "fixture-token",
      RALPH_ZAI_BASE_URL: "https://fixture.invalid/anthropic",
      ANTHROPIC_API_KEY: "must-disappear",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "must-disappear",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "must-disappear",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "must-disappear",
    },
  });
  check(run.status === 0 && run.stdout.includes("API_KEY=unset") && run.stdout.includes("PINS=unset,unset,unset"), "zai fixture sees API key and all model pins unset");
  check(run.stdout.includes("BASE=https://fixture.invalid/anthropic") && run.stdout.includes("TOKEN=fixture-token"), "zai fixture reads base URL and token from runtime env");
  check(run.stdout.includes("ARGS=-p --model glm-4.5-air") && run.stdout.includes("STDIN=fixture prompt"), "zai reviewer invokes claude read-only with requested model and stdin prompt");

  const defaultRun = spawnSync("env", ["-u", "RALPH_ZAI_BASE_URL", "-u", "RALPH_ZAI_AUTH_TOKEN", "bash", "-c", z.BUILD], {
    encoding: "utf-8",
    input: "default fixture\n",
    env: { ...process.env, PATH: `${fixture}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  check(defaultRun.status === 0 && defaultRun.stdout.includes("BASE=https://api.z.ai/api/anthropic") && defaultRun.stdout.includes("TOKEN="), "zai defaults to the verified API route and still forms with an empty token");
  rmSync(fixture, { recursive: true, force: true });
}

console.log("3) backward-compat: no spec/preset -> resolver is a no-op");
{
  const none = resolve({ RALPH_PROFILE: "", BUILDER_PROVIDER: "", REVIEWER_PROVIDER: "", BUILDER_MODEL: "", REVIEWER_MODEL: "", BUILDER_EFFORT: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  check(none.BUILDER === "<unset>" && none.REVIEWER === "<unset>", "BUILDER/REVIEWER left untouched (legacy --builder path intact)");
  check(none.BUILD === "<unset>", "no synthetic backend composed");
}

console.log("4) per-run override: an explicit knob beats the preset");
{
  const o = resolve({ RALPH_PROFILE: "cheap", BUILDER_EFFORT: "high", BUILDER_PROVIDER: "", REVIEWER_PROVIDER: "", BUILDER_MODEL: "", REVIEWER_MODEL: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  check(/model_reasoning_effort=high/.test(o.BUILD), "BUILDER_EFFORT=high overrides cheap's low");
}

console.log("5) claude env hygiene: shipped and normalized commands unset inherited provider config");
{
  const fixture = mkdtempSync(path.join(tmpdir(), "ralph-claude-env-"));
  const stub = path.join(fixture, "claude");
  const prompt = path.join(fixture, "prompt.txt");
  writeFileSync(stub, `#!/usr/bin/env bash
for name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL; do
  if printenv "$name" >/dev/null; then printf '%s\\n' "SET:$name"; else printf '%s\\n' "UNSET:$name"; fi
done
`);
  chmodSync(stub, 0o755);
  writeFileSync(prompt, "fixture prompt\n");
  const inherited = {
    ANTHROPIC_API_KEY: "sentinel",
    ANTHROPIC_AUTH_TOKEN: "sentinel",
    ANTHROPIC_BASE_URL: "https://sentinel.invalid",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sentinel",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "sentinel",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "sentinel",
  };
  const expected = Object.keys(inherited).map((name) => `UNSET:${name}`).join("\n");
  const commands = resolve({ BUILDER_PROVIDER: "claude", BUILDER_MODEL: "sonnet", RALPH_PROFILE: "", REVIEWER_PROVIDER: "", BUILDER_EFFORT: "", REVIEWER_MODEL: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" });
  for (const [label, command] of [["shipped", commands.CLAUDE], ["normalized", commands.BUILD]]) {
    const r = spawnSync("bash", ["-c", command], {
      encoding: "utf-8",
      input: readFileSync(prompt),
      env: { ...process.env, ...inherited, PATH: `${fixture}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    check(r.status === 0 && r.stdout.trim() === expected, `${label} claude command hides all inherited provider variables from the executable`);
  }
  rmSync(fixture, { recursive: true, force: true });
}

console.log("6) wrapper model hygiene: one authoritative selector or an early conflict");
{
  const base = { BUILDER_PROVIDER: "wrapped", RALPH_PROFILE: "", REVIEWER_PROVIDER: "", BUILDER_EFFORT: "", REVIEWER_MODEL: "", REVIEWER_EFFORT: "", BUILDER: "", REVIEWER: "" };
  const matching = resolve({ ...base, AGENT_WRAPPED_CMD: "wrapped --model opus -p", BUILDER_MODEL: "opus" });
  check(matching.status === 0 && matching.BUILD === "wrapped --model opus -p", "matching wrapper and Ralph models compose with one selector");
  check((matching.BUILD.match(/--model/g) || []).length === 1, "matching model selector is not duplicated");

  const missing = resolve({ ...base, AGENT_WRAPPED_CMD: "wrapped -p", BUILDER_MODEL: "glm-4.7" });
  check(missing.status === 0 && missing.BUILD === "wrapped -p --model glm-4.7", "wrapper without a model receives Ralph's single explicit selector");

  const conflict = resolve({ ...base, AGENT_WRAPPED_CMD: "wrapped --model opus -p", BUILDER_MODEL: "glm-4.7" });
  check(conflict.status !== 0, "conflicting wrapper and Ralph models fail during resolution");
  check(conflict.raw.includes("wrapper selects 'opus' but Ralph explicitly requested 'glm-4.7'"), "conflict error names both model values");

  const duplicate = resolve({ ...base, AGENT_WRAPPED_CMD: "wrapped --model opus --model opus -p", BUILDER_MODEL: "" });
  check(duplicate.status !== 0 && duplicate.raw.includes("duplicate model selectors") && duplicate.raw.includes("'opus'"), "duplicate selectors fail before command dispatch with their value");
}

console.log("7) dry run end-to-end: RALPH_PROFILE + --profile resolve through `ralph batch`");
{
  const target = mkdtempSync(path.join(tmpdir(), "ralph-as-"));
  const g = (args) => spawnSync("git", args, { cwd: target, encoding: "utf-8" });
  g(["init", "-q"]); g(["config", "user.email", "t@e.com"]); g(["config", "user.name", "t"]);
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  writeFileSync(path.join(target, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(target, "scripts", "check.sh"), 0o755);
  writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify({ check: "./scripts/check.sh", preview: { enabled: false } }));
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  const plan = mkdtempSync(path.join(tmpdir(), "ralph-asp-"));
  writeFileSync(path.join(plan, "01-x.md"), "# X\ndo x\n");
  const wt = path.join(target, "..", `ralph-wt-${path.basename(target)}`);
  try {
    const r = spawnSync(process.execPath, [cliPath, "batch", "--repo", target, "--plan", plan, "--profile", "cheap", "--builder-effort", "high"], {
      encoding: "utf-8",
      env: { ...process.env, BUILDER: "", REVIEWER: "", RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wt },
    });
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, `dry-run batch with --profile resolves and exits 0 (got ${r.status})`);
    check(/builder:\s+ralph-build\s+->\s+codex exec .*model_reasoning_effort=high/.test(out), "--builder-effort high overrode the cheap preset through the CLI");
    // `--json` may sit between `exec` and the sandbox flag when usage capture is on
    // (the default — see RALPH_USAGE in batch-loop.sh). The property under test is that
    // the reviewer is composed READ-ONLY, which the optional flag does not affect.
    check(/reviewer:\s+ralph-review .*->\s+codex exec (?:--json )?--sandbox read-only/.test(out), "reviewer composed read-only from the preset");
  } finally {
    try { rmSync(wt, { recursive: true, force: true }); } catch {}
    rmSync(target, { recursive: true, force: true });
    rmSync(plan, { recursive: true, force: true });
  }
}

console.log(`\nagent-selection: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
