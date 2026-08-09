// Tests for the cron/orchestrator loop DRIVER knob RALPH_CRON_DRIVER (#52).
// Hermetic: sources the shell config and resolves commands — no real agent runs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsSh = path.join(repoRoot, ".agents", "ralph", "agents.sh");
const configSh = path.join(repoRoot, ".agents", "ralph", "config.sh");
const orchestratorMd = path.join(repoRoot, ".agents", "ralph", "ORCHESTRATOR.md");
const configExample = path.join(repoRoot, ".agents", "ralph", "config.local.sh.example");
const tplDir = path.join(repoRoot, ".agents", "ralph", "target-templates");
const wrapperTpl = path.join(tplDir, "unattended-loop.sh.example");
const plistTpl = path.join(tplDir, "unattended-loop.plist.example");
const operatingMd = path.join(repoRoot, "docs", "OPERATING.md");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
};

// Source agents.sh + config.sh exactly as the loops do (agents.sh first, config.sh
// after), resolve the cron driver, and print what came out. The resolver is called
// in the CURRENT shell (output redirected to a file, not captured with `$(...)`) so
// its RALPH_CRON_DRIVER_BACKEND / AGENT_RALPH_CRON_CMD globals survive — that is the
// documented calling convention for a driver script that wants the backend name.
// Role selection is run too, so we can prove the knob leaves builder/reviewer alone.
// `override` is shell sourced AFTER config.sh, standing in for config.local.sh — the
// LAST file the loops source, and therefore the one that proves nothing froze earlier.
function resolveDriver(env, override = "") {
  const script = `
    set -uo pipefail
    source ${JSON.stringify(agentsSh)}
    . ${JSON.stringify(configSh)}
    ${override}
    out="$(mktemp)"
    ralph_resolve_cron_driver > "$out"; echo "STATUS=$?"
    CMD="$(cat "$out")"; rm -f "$out"
    ralph_resolve_role_agents
    echo "CMD=$CMD"
    echo "BACKEND=\${RALPH_CRON_DRIVER_BACKEND:-<unset>}"
    echo "DEFAULT=\${RALPH_CRON_DRIVER_DEFAULT:-<unset>}"
    echo "VIA_BACKEND=$(resolve_backend_cmd "\${RALPH_CRON_DRIVER_BACKEND:-}")"
    echo "BUILDER=\${BUILDER:-<unset>}"
    echo "REVIEWER=\${REVIEWER:-<unset>}"
    echo "BUILD=\${AGENT_RALPH_BUILD_CMD:-<unset>}"
    echo "CODEX=\${AGENT_CODEX_CMD}"
  `;
  // Clear the knobs by default so an operator's ambient env can't skew a run.
  const base = {
    RALPH_CRON_DRIVER: "", RALPH_CRON_DRIVER_DEFAULT: "", RALPH_CRON_DRIVER_PROVIDER: "",
    RALPH_CRON_DRIVER_MODEL: "", RALPH_CRON_DRIVER_EFFORT: "",
    BUILDER: "", REVIEWER: "", BUILDER_PROVIDER: "", REVIEWER_PROVIDER: "", BUILDER_MODEL: "",
    REVIEWER_MODEL: "", BUILDER_EFFORT: "", REVIEWER_EFFORT: "", RALPH_PROFILE: "",
  };
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: { ...process.env, ...base, ...env } });
  const out = `${r.stdout}${r.stderr}`;
  const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1] ?? "";
  return {
    exit: r.status, status: Number(get("STATUS")), CMD: get("CMD"), BACKEND: get("BACKEND"),
    DEFAULT: get("DEFAULT"), VIA_BACKEND: get("VIA_BACKEND"), BUILDER: get("BUILDER"),
    REVIEWER: get("REVIEWER"), BUILD: get("BUILD"), CODEX: get("CODEX"), raw: out,
  };
}

console.log("1) unset -> the documented default resolves (no vendor hardcoded at the call site)");
{
  const d = resolveDriver({});
  check(d.status === 0 && d.CMD !== "", "unset RALPH_CRON_DRIVER still resolves to a command");
  check(d.BACKEND === "codex", "unset -> RALPH_CRON_DRIVER_DEFAULT -> $DEFAULT_AGENT (the install's own default)");
  check(d.CMD === d.CODEX, "the default backend's own command is what resolves");

  // The default is a pointer, not a hardcode: repointing it moves the driver — and it
  // is read at resolve time, so a config.local.sh-late override still wins.
  const repointed = resolveDriver({ RALPH_CRON_DRIVER_DEFAULT: "claude" });
  check(repointed.status === 0 && repointed.BACKEND === "claude" && /(^| )claude -p/.test(repointed.CMD),
    "RALPH_CRON_DRIVER_DEFAULT repoints the unset default to another vendor");

  const late = resolveDriver({}, 'RALPH_CRON_DRIVER_DEFAULT="opencode-z"');
  check(late.BACKEND === "opencode-z" && late.CMD.startsWith("opencode run"),
    "a driver default set as late as config.local.sh is honoured (nothing froze it earlier)");

  const viaDefaultAgent = resolveDriver({}, 'DEFAULT_AGENT="droid"');
  check(viaDefaultAgent.BACKEND === "droid" && viaDefaultAgent.CMD.startsWith("droid exec"),
    "with both driver knobs unset the default follows $DEFAULT_AGENT, not a literal vendor");
}

console.log("2) a backend NAME resolves exactly like a role backend");
{
  const named = resolveDriver({ RALPH_CRON_DRIVER: "codex-readonly" });
  check(named.status === 0 && named.BACKEND === "codex-readonly" && named.CMD === "codex exec -c 'mcp_servers={}' --disable apps --sandbox read-only -",
    "a shipped backend name resolves to that backend's command");
  check(named.CMD === named.VIA_BACKEND, "the resolved command equals resolve_backend_cmd(<backend>)");

  const custom = resolveDriver({ RALPH_CRON_DRIVER: "free-tier", AGENT_FREE_TIER_CMD: "free-tier run -p" });
  check(custom.status === 0 && custom.CMD === "free-tier run -p",
    "an operator-defined AGENT_<NAME>_CMD works as a driver with no code change (free-tier/OpenRouter ready)");

  const missing = resolveDriver({ RALPH_CRON_DRIVER: "nope-driver" });
  check(missing.status !== 0, "an undefined driver name fails resolution instead of silently running nothing");
  check(/AGENT_NOPE_DRIVER_CMD/.test(missing.raw), "the error names the variable to define");
}

console.log("3) a normalized {provider, model, effort} spec composes like a role spec");
{
  const z = resolveDriver({ RALPH_CRON_DRIVER_PROVIDER: "zai", RALPH_CRON_DRIVER_MODEL: "glm-4.5-air" });
  check(z.status === 0 && z.BACKEND === "ralph-cron", "a normalized spec is exposed as the synthetic backend ralph-cron");
  check(z.CMD.endsWith(" --model glm-4.5-air") && z.CMD.includes("ANTHROPIC_AUTH_TOKEN="),
    "the cheapest-plan model passes through the shared Z.AI composer");
  check(z.CMD === z.VIA_BACKEND, "AGENT_RALPH_CRON_CMD is exported so resolve_backend_cmd finds it");

  const eff = resolveDriver({ RALPH_CRON_DRIVER_PROVIDER: "codex", RALPH_CRON_DRIVER_EFFORT: "low" });
  check(eff.CMD === "codex exec -c 'mcp_servers={}' --disable apps --yolo --skip-git-repo-check -c model_reasoning_effort=low -",
    "effort maps through the same adapter, and the driver is composed writable (it files PRs)");

  const modelOnly = resolveDriver({ RALPH_CRON_DRIVER: "codex", RALPH_CRON_DRIVER_MODEL: "gpt-5-mini" });
  check(modelOnly.status === 0 && modelOnly.CMD === "codex exec -c 'mcp_servers={}' --disable apps --yolo --skip-git-repo-check -m gpt-5-mini -",
    "a model with no provider uses the name spelling as the provider");
}

console.log("4) the driver knob does not touch builder/reviewer selection");
{
  const d = resolveDriver({ RALPH_CRON_DRIVER_PROVIDER: "zai", RALPH_CRON_DRIVER_MODEL: "glm-4.5-air" });
  check(d.BUILDER === "<unset>" && d.REVIEWER === "<unset>" && d.BUILD === "<unset>",
    "a driver spec alone leaves BUILDER/REVIEWER and the role composer untouched");

  const both = resolveDriver({ RALPH_CRON_DRIVER: "claude", BUILDER_PROVIDER: "codex", BUILDER_EFFORT: "high" });
  check(both.BUILDER === "ralph-build" && both.BUILD === "codex exec -c 'mcp_servers={}' --disable apps --yolo --skip-git-repo-check -c model_reasoning_effort=high -",
    "role selection is unaffected by a driver set alongside it");
  check(/(^| )claude -p/.test(both.CMD), "and the driver keeps its own separate command");
}

console.log("5) the resolved command is actually runnable (stub binary, no real agent)");
{
  const fixture = mkdtempSync(path.join(tmpdir(), "ralph-cron-"));
  const stub = path.join(fixture, "cheapdriver");
  writeFileSync(stub, `#!/usr/bin/env bash
printf 'ARGS=%s\\n' "$*"
read -r line
printf 'STDIN=%s\\n' "$line"
`);
  chmodSync(stub, 0o755);
  try {
    const d = resolveDriver({ RALPH_CRON_DRIVER: "cheap", AGENT_CHEAP_CMD: "cheapdriver --run -" });
    const run = spawnSync("bash", ["-c", d.CMD], {
      encoding: "utf-8",
      input: "run one orchestrator pass\n",
      env: { ...process.env, PATH: `${fixture}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    check(run.status === 0 && run.stdout.includes("ARGS=--run -"), "the resolved driver command executes with its flags");
    check(run.stdout.includes("STDIN=run one orchestrator pass"), "and receives the pass prompt on stdin");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

console.log("6) the convention and its ownership are documented where operators look");
{
  const config = readFileSync(configSh, "utf-8");
  check(/RALPH_CRON_DRIVER_PROVIDER/.test(config) && /RALPH_CRON_DRIVER_DEFAULT\s+->\s+\$DEFAULT_AGENT/.test(config),
    "config.sh defines both spellings of the convention and the default chain applied when unset");
  check(/cheapest competent/i.test(config), "config.sh documents the cheapest-competent guidance");

  const example = readFileSync(configExample, "utf-8");
  check(/RALPH_CRON_DRIVER/.test(example) && /cheapest competent/i.test(example) && /orchestrator/i.test(example),
    "config.local.sh.example documents the knob, the cheapest-competent guidance, and who owns it");

  const charter = readFileSync(orchestratorMd, "utf-8");
  check(/RALPH_CRON_DRIVER/.test(charter) && /remit/i.test(charter),
    "ORCHESTRATOR.md claims driver selection as the orchestrator's remit");
  check(/cheapest/i.test(charter) && /ledger\.jsonl|pool/i.test(charter),
    "…with the cheapest-competent default and the pool-aware cost decision");
}

console.log("7) the shipped unattended-loop templates bake in the four known pitfalls (#69)");
{
  // The wrapper. Operators copy this verbatim, so the rails must be IN the file, not
  // only in prose: prompt read from a file, config.local.sh sourced+exported for BOTH
  // identity paths, plans staged under .ralph/. tests/shell-syntax.mjs parse-checks it.
  const wrapper = readFileSync(wrapperTpl, "utf-8");
  check(/\{prompt\}/.test(wrapper) && /eval "\$DRIVER_CMD" <"\$PROMPT_FILE"/.test(wrapper),
    "pitfall 1: the prompt is passed by file path or on stdin, never interpolated as text");
  check(!/^\s*(DRIVER_)?\w*(PROMPT|prompt)\w*=(["']).*\b(Run|read)\b/m.test(wrapper),
    "…and the wrapper never assigns an inline prompt STRING");
  check(/PROMPT_FILE=/.test(wrapper) && /-f "\$PROMPT_FILE"/.test(wrapper),
    "…the prompt path is a configurable FILE the wrapper checks for");
  check(/exec >>"\$LOG_FILE" 2>&1/.test(wrapper) && /exit "\$STATUS"/.test(wrapper),
    "pitfall 2: the wrapper logs both streams and propagates the driver's exit code");
  check(/set -a/.test(wrapper) && /set \+a/.test(wrapper),
    "pitfall 3: config is sourced under `set -a` so `: \"${VAR:=v}\"` values are EXPORTED to ralph");
  check((wrapper.match(/config\.local\.sh/g) || []).length >= 2 && /RALPH_HOME/.test(wrapper) && /TARGET_REPO/.test(wrapper),
    "…both the harness and the target config.local.sh are sourced (the two identity paths)");
  check(/^cd "\$TARGET_REPO"$/m.test(wrapper),
    "…and it cds into the target first, since cwd decides which .agents/ralph ralph uses");
  check(/resolve-identity\.sh/.test(wrapper) && /export RALPH_IDENTITY_WRAPPER=/.test(wrapper),
    "…identity is resolved once and EXPORTED, so `ralph integrate --pr` resolves it too");
  check(/STATE_DIR="\$TARGET_REPO\/\.ralph"/.test(wrapper) && /PLAN_DIR="\$STATE_DIR\/plans"/.test(wrapper),
    "pitfall 4: plans are staged under .ralph/ (gitignored), not the repo root");
  check(/export RALPH_WORKTREE_DIR=/.test(wrapper), "…and run worktrees are pinned outside the tree as well");
  check(/ralph_resolve_cron_driver >"\$DRIVER_OUT"/.test(wrapper),
    "the driver is resolved with ralph_resolve_cron_driver, redirected (not $(...)) so its exports survive");

  // The launchd unit. A plist with no log paths is the reason failures go unnoticed.
  const plist = readFileSync(plistTpl, "utf-8");
  check(/<key>StandardOutPath<\/key>/.test(plist) && /<key>StandardErrorPath<\/key>/.test(plist),
    "the launchd plist sets StandardOutPath AND StandardErrorPath (never silent)");
  check(/<key>Label<\/key>/.test(plist) && /<key>ProgramArguments<\/key>/.test(plist) &&
    /<key>StartInterval<\/key>|<key>StartCalendarInterval<\/key>/.test(plist),
    "…and is a complete job: Label, ProgramArguments and a cadence");
  check(/unattended-loop\.sh/.test(plist), "…pointing at the wrapper template, not an inline command");

  // Nothing machine-specific: both templates are .example placeholders. Checked against
  // THIS machine, so a template edited on a real setup and committed with its own paths
  // baked in fails here rather than shipping someone's home directory to every operator.
  const home = os.homedir();
  const user = os.userInfo().username;
  for (const [name, body] of [["wrapper", wrapper], ["plist", plist]]) {
    check(/\/absolute\/path\/to\/|YOUR-USERNAME/.test(body), `the ${name} template ships fill-me-in placeholders`);
    check(!body.includes(home) && !new RegExp(`/(Users|home)/${user}\\b`).test(body),
      `…and no path from the machine that committed it (${name})`);
  }

  // The pitfalls are enumerated for operators, with the non-macOS equivalents.
  const ops = readFileSync(operatingMd, "utf-8");
  check(/unattended loop/i.test(ops), "docs/OPERATING.md has a 'setting up the unattended loop' section");
  for (const [label, re] of [
    ["inline-quoted prompt", /inline-quoted prompt/i],
    ["silent stderr", /Silent stderr/i],
    ["two identity paths", /Two identity paths/i],
    ["plan staging", /Plan artifacts in the repo root/i],
  ]) check(re.test(ops), `…enumerating pitfall: ${label}`);
  check(/StandardOutPath/.test(ops) && /StandardErrorPath/.test(ops), "…with the plist log-path fix named");
  check(/unattended-loop\.sh\.example/.test(ops) && /unattended-loop\.plist\.example/.test(ops),
    "…and pointing at both shipped templates by path");
  check(/\bcron\b/.test(ops) && /systemd/i.test(ops) && /OnCalendar/.test(ops),
    "…plus a cron and systemd equivalent for non-macOS operators");
}

console.log(`\ncron-driver: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
