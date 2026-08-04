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

console.log("3) a non-JSON backend is still left completely alone");
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

console.log("4) usage capture is ON by default, and OFF only when asked");
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

console.log("5) GUARD: an unrecognised JSON shape must not break the verdict parse");
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

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll usage-per-backend checks passed");
