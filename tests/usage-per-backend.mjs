// Per-backend usage capture (#40).
//
// Two families, two flags, two JSON shapes (see references/TOKEN_ECONOMICS.md):
//   claude-CLI   --output-format json   cache_read_input_tokens / cache_creation_input_tokens
//   codex        --json  (JSONL)        cached_input_tokens / cache_write_input_tokens
//
// The dangerous half is not the sidecar, it's the LOG. Both flags turn stdout into JSON;
// if that reaches the reviewer's `^VERDICT:` grep un-extracted it never matches, which
// means REVIEWER_UNAVAILABLE and retries until MAX_ITERATIONS — a silent token burn.
// So every assertion about usage is paired with one about the log still being greppable.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✔ ${msg}`);
  else { console.error(`  x FAIL: ${msg}`); failures += 1; }
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function writeScript(p, body) { writeFileSync(p, body); chmodSync(p, 0o755); }
function ralph(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", ...env },
  });
}
function wtBase(t) { return path.join(t, "..", `ralph-wt-${path.basename(t)}`); }
function cleanup(t) { try { rmSync(wtBase(t), { recursive: true, force: true }); } catch {} rmSync(t, { recursive: true, force: true }); }
function makeTarget() {
  const t = mkdtempSync(path.join(tmpdir(), "ralph-usage40-"));
  git(t, ["init", "-q"]); git(t, ["config", "user.email", "t@e.com"]); git(t, ["config", "user.name", "t"]);
  writeFileSync(path.join(t, "README.md"), "# T\n");
  mkdirSync(path.join(t, "scripts"), { recursive: true });
  writeScript(path.join(t, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(path.join(t, "ralph.target.json"), JSON.stringify({ check: "./scripts/check.sh", preview: { enabled: false } }, null, 2));
  writeFileSync(path.join(t, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(t, ["add", "-A"]); git(t, ["commit", "-q", "-m", "init"]);
  return t;
}
function onePlan() {
  const d = mkdtempSync(path.join(tmpdir(), "ralph-usage40-plan-"));
  writeFileSync(path.join(d, "01.md"), "# Task one\nAppend a line.\n");
  return d;
}
function runDirOf(t) {
  const root = path.join(t, ".agent-run");
  const dirs = readdirSync(root).filter((x) => x.startsWith("batch-")).sort();
  return path.join(root, dirs[dirs.length - 1]);
}
function cfg(t) { return readFileSync(path.join(runDirOf(t), "config.resolved.env"), "utf-8"); }

console.log("1) RALPH_USAGE=1 injects the right flag per backend family (dry-run, no spend)");
{
  const t = makeTarget();
  const plan = onePlan();
  try {
    // codex -> `--json`, inserted right after `exec`
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "codex", "--reviewer", "codex-readonly",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t) });
    const c = cfg(t);
    const bcmd = (c.match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    const rcmd = (c.match(/^REVIEWER_CMD=(.*)$/m) || [])[1] || "";
    check(/\bexec --json\b/.test(bcmd), `codex builder got --json after exec (${bcmd})`);
    check(/\bexec --json\b/.test(rcmd), "codex reviewer got --json after exec");
    check(!/--output-format/.test(bcmd), "codex did NOT get the claude-only --output-format flag");
    check(/ -$/.test(bcmd.trim()) || / - /.test(bcmd), "the trailing stdin '-' survived the insertion");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}
{
  const t = makeTarget();
  const plan = onePlan();
  try {
    // claude -> `--output-format json` (unchanged behaviour, guarding against regression)
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "claude", "--reviewer", "claude",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t) });
    const bcmd = (cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    check(/--output-format json/.test(bcmd), "claude builder still gets --output-format json");
    check(!/ --json\b/.test(bcmd), "claude did NOT get codex's --json flag");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}
{
  const t = makeTarget();
  const plan = onePlan();
  try {
    // opencode -> deliberately untouched (#44: output shape unverified)
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "opencode", "--reviewer", "opencode",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t) });
    const bcmd = (cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    check(!/--json|--output-format|--format json/.test(bcmd), `opencode left uninstrumented (${bcmd})`);
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}
{
  const t = makeTarget();
  const plan = onePlan();
  try {
    // zlaude remains an explicitly configured claude-CLI wrapper. Z.AI may omit
    // cache_creation_input_tokens, but it still needs Claude JSON mode for reads.
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "zlaude", "--reviewer", "codex-readonly",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t),
        AGENT_ZLAUDE_CMD: 'zlaude --model glm-4.7 -p "$(cat {prompt})"' });
    const bcmd = (cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    check(/zlaude --output-format json/.test(bcmd), "zlaude wrapper still gets Claude JSON instrumentation");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}

console.log("2) codex JSONL -> usage sidecar, and the log is rewritten so ^VERDICT: still greps");
{
  const t = makeTarget();
  const plan = onePlan();
  // Fake reviewer emitting REAL codex-shaped JSONL (captured from codex 0.146.0).
  // Written to a fixture file and `cat`-ed rather than printf-ed: the JSON contains
  // \n escapes of its own, and round-tripping those through shell quoting corrupts it.
  const fixDir = mkdtempSync(path.join(tmpdir(), "ralph-usage40-fix-"));
  const fix = path.join(fixDir, "codex.jsonl");
  writeFileSync(fix, [
    JSON.stringify({ type: "thread.started", thread_id: "019fcd59-dead-beef" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message",
      text: "### Must-fix issues\n- none\n\nVERDICT: PASS" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 16781, cached_input_tokens: 11008,
      cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 3 } }),
  ].join("\n") + "\n");
  const FB = 'bash -c "echo x >> progress.txt; printf \\"# handoff\\n\\" > .agent-handoff.md"';
  try {
    const r = ralph(["batch", "--repo", t, "--plan", plan, "--builder", "fb", "--reviewer", "cxrev",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "", RALPH_WORKTREE_DIR: wtBase(t),
        AGENT_FB_CMD: FB, AGENT_CXREV_CMD: `cat ${fix}` });
    const out = `${r.stdout}${r.stderr}`;
    const rd = runDirOf(t);

    // The whole point: JSON on stdout must not defeat verdict parsing.
    check(/verdict: PASS/.test(out), "verdict parsed as PASS from rewritten log (not REVIEWER_UNAVAILABLE)");
    const log = readFileSync(path.join(rd, "task-001-iter-1-reviewer.md"), "utf-8");
    check(/^VERDICT: PASS$/m.test(log), "log was rewritten to plain text carrying the VERDICT line");
    check(!log.includes('"turn.completed"'), "raw JSONL no longer in the log");
    check(log.includes("Must-fix issues"), "the agent_message body survived the rewrite");

    const side = path.join(rd, "task-001-iter-1-reviewer.usage.json");
    check(existsSync(side), "usage sidecar written for a codex-shaped log");
    if (existsSync(side)) {
      const u = JSON.parse(readFileSync(side, "utf-8"));
      check(u.input === 16781, `input mapped from input_tokens (${u.input})`);
      check(u.cache_read === 11008, `cache_read mapped from cached_input_tokens (${u.cache_read})`);
      check(u.cache_creation === 0, `cache_creation mapped from cache_write_input_tokens (${u.cache_creation})`);
      check(u.output === 5, `output mapped (${u.output})`);
      check(u.reasoning_output === 3, `reasoning_output captured (${u.reasoning_output})`);
    }
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); rmSync(fixDir, { recursive: true, force: true }); }
}

console.log("3) a model-pinned claude alias gets JSON instrumentation and a usage sidecar");
{
  const t = makeTarget();
  const plan = onePlan();
  const fixDir = mkdtempSync(path.join(tmpdir(), "ralph-usage51-claude-"));
  const stub = path.join(fixDir, "claude");
  writeScript(stub, `#!/usr/bin/env bash
case " $* " in
  *" --output-format json "*) ;;
  *) printf 'VERDICT: PASS\\n'; exit 0 ;;
esac
cat <<'JSON'
{"type":"result","subtype":"success","result":"### Must-fix issues\\n- none\\n\\nVERDICT: PASS","usage":{"input_tokens":321,"output_tokens":17,"cache_read_input_tokens":89,"cache_creation_input_tokens":4},"num_turns":2,"duration_ms":700,"total_cost_usd":0.01}
JSON
`);
  const FB = 'bash -c "echo x >> progress.txt; printf \\"# handoff\\n\\" > .agent-handoff.md"';
  try {
    const r = ralph(["batch", "--repo", t, "--plan", plan, "--builder", "fb", "--reviewer", "claude-sonnet",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t),
        PATH: `${fixDir}:${process.env.PATH}`, AGENT_FB_CMD: FB,
        AGENT_CLAUDE_SONNET_CMD: 'env FIXTURE_CLAUDE=1  claude --model sonnet -p "$(cat {prompt})"' });
    const out = `${r.stdout}${r.stderr}`;
    const rd = runDirOf(t);
    const side = path.join(rd, "task-001-iter-1-reviewer.usage.json");
    check(r.status === 0 && /verdict: PASS/.test(out), "model-pinned claude-sonnet batch passes");
    check(existsSync(side), "model-pinned claude-sonnet writes a usage sidecar");
    if (existsSync(side)) {
      const u = JSON.parse(readFileSync(side, "utf-8"));
      check(u.input === 321 && u.output === 17 && u.cache_read === 89 && u.cache_creation === 4,
        "claude-sonnet sidecar populates input/output/cache fields");
    }
    const log = readFileSync(path.join(rd, "task-001-iter-1-reviewer.md"), "utf-8");
    check(/^VERDICT: PASS$/m.test(log) && !log.includes('"usage"'),
      "claude-sonnet JSON result is extracted back to a greppable log");
  } finally {
    cleanup(t); rmSync(plan, { recursive: true, force: true }); rmSync(fixDir, { recursive: true, force: true });
  }
}

console.log("4) a non-JSON backend is still left completely alone");
{
  const t = makeTarget();
  const plan = onePlan();
  const FB = 'bash -c "echo x >> progress.txt; printf \\"# handoff\\n\\" > .agent-handoff.md"';
  try {
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "fb", "--reviewer", "plainrev",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "", RALPH_WORKTREE_DIR: wtBase(t),
        AGENT_FB_CMD: FB, AGENT_PLAINREV_CMD: 'bash -c \'printf "looks good\\n\\nVERDICT: PASS\\n"\'' });
    const rd = runDirOf(t);
    const log = readFileSync(path.join(rd, "task-001-iter-1-reviewer.md"), "utf-8");
    check(log.includes("looks good"), "plain-text log untouched");
    check(!existsSync(path.join(rd, "task-001-iter-1-reviewer.usage.json")), "no sidecar invented for a plain-text backend");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}

console.log("5) usage capture is ON by default, and OFF only when asked");
{
  const t = makeTarget();
  const plan = onePlan();
  try {
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "codex", "--reviewer", "codex-readonly",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_WORKTREE_DIR: wtBase(t) });          // no RALPH_USAGE set
    check(/\bexec --json\b/.test((cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || ""),
      "default (unset) instruments codex — cost visibility is opt-OUT");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}
{
  const t = makeTarget();
  const plan = onePlan();
  try {
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "codex", "--reviewer", "codex-readonly",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "0", RALPH_WORKTREE_DIR: wtBase(t) });
    check(!/--json/.test((cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || ""),
      "RALPH_USAGE=0 disables instrumentation");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}

console.log("6) GUARD: an unrecognised JSON shape must not break the verdict parse");
{
  // This is what makes default-on safe. Simulate a CLI that renamed its events: the
  // JSON is well-formed but nothing matches the shapes we know. Without the salvage,
  // the log stays JSON, `^VERDICT:` never matches, and EVERY attempt becomes
  // REVIEWER_UNAVAILABLE until MAX_ITERATIONS — fleet-wide, with a misleading symptom.
  const t = makeTarget();
  const plan = onePlan();
  const fixDir = mkdtempSync(path.join(tmpdir(), "ralph-usage40-drift-"));
  const fix = path.join(fixDir, "drift.jsonl");
  writeFileSync(fix, [
    JSON.stringify({ kind: "conversation.begin", id: "abc" }),
    JSON.stringify({ kind: "assistant.said", payload: { body: { text: "### Must-fix issues\n- none\n\nVERDICT: PASS" } } }),
    JSON.stringify({ kind: "conversation.end", tokens: { in: 100, out: 5 } }),
  ].join("\n") + "\n");
  const FB = 'bash -c "echo x >> progress.txt; printf \\"# handoff\\n\\" > .agent-handoff.md"';
  try {
    const r = ralph(["batch", "--repo", t, "--plan", plan, "--builder", "fb", "--reviewer", "driftrev",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "", RALPH_WORKTREE_DIR: wtBase(t),
        AGENT_FB_CMD: FB, AGENT_DRIFTREV_CMD: `cat ${fix}` });
    const out = `${r.stdout}${r.stderr}`;
    const rd = runDirOf(t);
    const log = readFileSync(path.join(rd, "task-001-iter-1-reviewer.md"), "utf-8");

    check(/verdict: PASS/.test(out), "verdict STILL parses despite an unknown JSON shape (run survives)");
    check(/^VERDICT: PASS$/m.test(log), "text was salvaged from the unknown shape into the log");
    check(!log.includes('"kind"'), "raw unknown-shape JSON no longer in the log");
    check(/unrecognised shape/i.test(out), "harness warns loudly that metrics were not captured");
    check(!existsSync(path.join(rd, "task-001-iter-1-reviewer.usage.json")),
      "no sidecar invented from an unparsed shape (metrics absent, not fabricated)");
  } finally {
    cleanup(t); rmSync(plan, { recursive: true, force: true }); rmSync(fixDir, { recursive: true, force: true });
  }
}

console.log("7) env-prefixed claude aliases: the flag lands after the REAL executable, never after env (#72)");
{
  // `env --output-format json … claude-sonnet …` is not just ugly, it is UNRUNNABLE:
  // BSD/macOS /usr/bin/env answers "illegal option -- o" and exits 1, so the builder
  // fails three times and the batch halts with BUILDER_UNAVAILABLE. The flag belongs to
  // the claude CLI, which means after env's own arguments.
  const t = makeTarget();
  const plan = onePlan();
  try {
    // Hyphenated alias: `claude-sonnet` is NOT the bare word `claude`.
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "claude-sonnet", "--reviewer", "claude-sonnet",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t),
        AGENT_CLAUDE_SONNET_CMD:
          'env -u ANTHROPIC_API_KEY -u ANTHROPIC_DEFAULT_SONNET_MODEL claude-sonnet -p "$(cat {prompt})"' });
    const bcmd = (cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    check(/\bclaude-sonnet --output-format json -p\b/.test(bcmd),
      `hyphenated alias: flag inserted after claude-sonnet, before its args (${bcmd})`);
    check(/-u ANTHROPIC_API_KEY -u ANTHROPIC_DEFAULT_SONNET_MODEL claude-sonnet\b/.test(bcmd),
      "env's own -u NAME pairs are stepped over intact, not split");
    check(!/\benv\s+--output-format/.test(bcmd), "no `env --output-format` — the #72 breakage is gone");
    check(!/--output-format[\s\S]*\bclaude-sonnet\b/.test(bcmd), "the flag is never ahead of the executable");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}
{
  // Bare form behind env: unchanged behaviour, flag still goes right after `claude`.
  const t = makeTarget();
  const plan = onePlan();
  try {
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "claude-sonnet", "--reviewer", "claude-sonnet",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t),
        AGENT_CLAUDE_SONNET_CMD: 'env -u ANTHROPIC_API_KEY claude --model sonnet -p "$(cat {prompt})"' });
    const bcmd = (cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    check(/\bclaude --output-format json --model sonnet\b/.test(bcmd),
      `bare form: flag inserted after claude, ahead of --model (${bcmd})`);
    check(!/\benv\s+--output-format/.test(bcmd), "bare form does not put the flag on env either");
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}
{
  // Already instrumented by the operator -> left exactly as configured.
  const t = makeTarget();
  const plan = onePlan();
  try {
    ralph(["batch", "--repo", t, "--plan", plan, "--builder", "claude-sonnet", "--reviewer", "claude-sonnet",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t),
        AGENT_CLAUDE_SONNET_CMD: 'env -u ANTHROPIC_API_KEY claude-sonnet --output-format json -p "$(cat {prompt})"' });
    const bcmd = (cfg(t).match(/^BUILDER_CMD=(.*)$/m) || [])[1] || "";
    check((bcmd.match(/--output-format/g) || []).length === 1, `no double-injection (${bcmd})`);
  } finally { cleanup(t); rmSync(plan, { recursive: true, force: true }); }
}
{
  // MUTATION GUARD, in two halves.
  // (a) The old code's env branch only matched the bare word `claude`, so a hyphenated
  //     alias fell through to the backend-name `claude-*` branch, which inserted after
  //     the FIRST token — `env`. Prove that regex really does miss `claude-sonnet`, and
  //     that the command it would have produced cannot run.
  const oldEnvBranch = /(^|\s)claude(\s|$)/;
  const alias = "env -u ANTHROPIC_API_KEY -u ANTHROPIC_DEFAULT_SONNET_MODEL claude-sonnet -p x";
  check(!oldEnvBranch.test(alias), "the old bare-word `claude` match does NOT see claude-sonnet (root cause)");
  check(oldEnvBranch.test("env -u ANTHROPIC_API_KEY claude --model sonnet -p x"),
    "…while it did see the bare form — which is why only the hyphenated alias broke");
  const bad = spawnSync("env", ["--output-format", "json", "true"], { encoding: "utf-8" });
  check(bad.status !== 0, `env rejects --output-format as its own flag (status ${bad.status}) — the bug was fatal, not cosmetic`);

  // (b) End to end through the REAL env(1): a stub named `claude-sonnet` records its
  //     argv, so we see the flag arrive as the executable's FIRST argument.
  const t = makeTarget();
  const plan = onePlan();
  const fixDir = mkdtempSync(path.join(tmpdir(), "ralph-usage72-"));
  const argDump = path.join(fixDir, "argv.txt");
  writeScript(path.join(fixDir, "claude-sonnet"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${argDump}
cat <<'JSON'
{"type":"result","subtype":"success","result":"### Must-fix issues\\n- none\\n\\nVERDICT: PASS","usage":{"input_tokens":7,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"num_turns":1,"duration_ms":10,"total_cost_usd":0.001}
JSON
`);
  const FB = 'bash -c "echo x >> progress.txt; printf \\"# handoff\\n\\" > .agent-handoff.md"';
  try {
    const r = ralph(["batch", "--repo", t, "--plan", plan, "--builder", "fb", "--reviewer", "claude-sonnet",
      "--auto-approve-builder", "--max-tasks", "1"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(t),
        PATH: `${fixDir}:${process.env.PATH}`, AGENT_FB_CMD: FB,
        AGENT_CLAUDE_SONNET_CMD:
          'env -u ANTHROPIC_API_KEY -u ANTHROPIC_DEFAULT_SONNET_MODEL claude-sonnet -p "$(cat {prompt})"' });
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0 && /verdict: PASS/.test(out), "the env-prefixed hyphenated alias actually RUNS and passes");
    check(!/backend unavailable/i.test(out), "no 'backend unavailable' (the #72 symptom)");
    const argv = existsSync(argDump) ? readFileSync(argDump, "utf-8") : "";
    check(/^--output-format json -p /m.test(argv),
      `the executable received the flag as its first argument (${argv.trim().slice(0, 80)})`);
    check(existsSync(path.join(runDirOf(t), "task-001-iter-1-reviewer.usage.json")),
      "and the usage sidecar is written, so the instrumentation was worth injecting");
  } finally {
    cleanup(t); rmSync(plan, { recursive: true, force: true }); rmSync(fixDir, { recursive: true, force: true });
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll usage-per-backend checks passed");
