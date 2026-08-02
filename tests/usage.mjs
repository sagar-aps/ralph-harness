// Tests for per-attempt usage instrumentation (#3) and the JSON→VERDICT footgun.
//
// The danger this guards: `claude --output-format json` collapses the response to a
// single-line JSON blob. If that reaches the reviewer's `^VERDICT:` grep un-extracted,
// it never matches → REVIEWER_UNAVAILABLE → retries until MAX_ITERATIONS (a token-burn
// regression). run_backend must extract `.result` back to plain text BEFORE the grep,
// and tee usage to a sidecar.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, chmodSync, rmSync,
} from "node:fs";
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
function ralph(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", ...env },
  });
}
function writeScript(p, body) { writeFileSync(p, body); chmodSync(p, 0o755); }
function makeTarget() {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-usage-"));
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  writeFileSync(path.join(target, "README.md"), "# T\n");
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  writeScript(path.join(target, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(path.join(target, "ralph.target.json"), JSON.stringify({ check: "./scripts/check.sh", preview: { enabled: false } }, null, 2));
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  return target;
}
function wtBase(target) { return path.join(target, "..", `ralph-wt-${path.basename(target)}`); }
function runDirOf(target) {
  const dir = path.join(target, ".agent-run");
  const d = readdirSync(dir).filter((x) => x.startsWith("batch-")).sort();
  return path.join(dir, d[d.length - 1]);
}
const tmps = [];
function planOneTask() {
  const dir = mkdtempSync(path.join(tmpdir(), "ralph-uplan-"));
  tmps.push(dir);
  writeFileSync(path.join(dir, "01-task.md"), "# Do a thing\nMake a change.\n");
  return dir;
}
function cleanup(target) {
  try { rmSync(wtBase(target), { recursive: true, force: true }); } catch {}
  rmSync(target, { recursive: true, force: true });
}

// A fake builder that emits Claude-shaped JSON on stdout while still making a real
// change + writing the handoff, so the batch can commit and advance.
const BUILDER_JSON = mkdtempSync(path.join(tmpdir(), "ralph-fa-"));
tmps.push(BUILDER_JSON);
const bJson = path.join(BUILDER_JSON, "builder.sh");
writeScript(bJson, `#!/usr/bin/env bash
echo "change $$-$RANDOM" >> built.txt
printf '# handoff\\n- did the thing\\n' > .agent-handoff.md
cat <<'JSON'
{"result":"built the thing","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"num_turns":2,"duration_ms":500,"total_cost_usd":0.005}
JSON
`);
const rJson = path.join(BUILDER_JSON, "reviewer.sh");
writeScript(rJson, `#!/usr/bin/env bash
cat <<'JSON'
{"result":"### Must-fix issues\\n- none\\n\\nVERDICT: PASS","usage":{"input_tokens":123,"output_tokens":45,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"num_turns":3,"duration_ms":900,"total_cost_usd":0.012}
JSON
`);

console.log("1) JSON agent output → .result extracted, verdict parsed (no ERROR), usage sidecars written");
{
  const target = makeTarget();
  const plan = planOneTask();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "bjson", "--reviewer", "rjson", "--auto-approve-builder"],
      {
        RALPH_AGENT_RETRY_DELAY: "0",
        RALPH_WORKTREE_DIR: wtBase(target),
        AGENT_BJSON_CMD: bJson,
        AGENT_RJSON_CMD: rJson,
      },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, `batch exits 0 (got ${r.status})`);
    check(!/reviewer ERROR/i.test(out), "no reviewer ERROR (JSON verdict was extracted, not left as a blob)");
    check(!/REVIEWER_UNAVAILABLE/.test(out), "outcome is not REVIEWER_UNAVAILABLE");
    check(/VERDICT: PASS|verdict: PASS/.test(out), "verdict PASS surfaced");

    const rd = runDirOf(target);
    const revSide = path.join(rd, "task-001-iter-1-reviewer.usage.json");
    const bldSide = path.join(rd, "task-001-iter-1-builder.usage.json");
    check(existsSync(revSide), "reviewer usage sidecar written (task-001-iter-1-reviewer.usage.json)");
    check(existsSync(bldSide), "builder usage sidecar written (task-001-iter-1-builder.usage.json)");
    if (existsSync(revSide)) {
      const u = JSON.parse(readFileSync(revSide, "utf-8"));
      check(u.input === 123 && u.output === 45 && u.cache_read === 10 && u.cache_creation === 5,
        "reviewer sidecar has numeric token counts");
      check(u.num_turns === 3, "reviewer sidecar records num_turns");
    }
    // The reviewer log the grep read must be plain text now, not a JSON blob.
    const revLog = readFileSync(path.join(rd, "task-001-iter-1-reviewer.md"), "utf-8");
    check(/^VERDICT: PASS$/m.test(revLog) && !/"result"/.test(revLog),
      "reviewer log was rewritten to plain text (VERDICT on its own line, no JSON envelope)");
  } finally { cleanup(target); }
}

console.log("2) RALPH_USAGE=1 injects --output-format json into a claude backend (only claude)");
{
  const target = makeTarget();
  const plan = planOneTask();
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "claude", "--reviewer", "codex", "--auto-approve-builder"],
      { RALPH_DRY_RUN: "1", RALPH_USAGE: "1", RALPH_WORKTREE_DIR: wtBase(target) },
    );
    const out = `${r.stdout}${r.stderr}`;
    check(/builder:.*claude --output-format json/.test(out), "claude builder command gains --output-format json");
    check(!/reviewer:.*codex --output-format json/.test(out), "codex reviewer is NOT given the claude-only flag");
  } finally { cleanup(target); }
}

console.log("3) Mutation: a raw JSON blob does NOT match ^VERDICT:, but the extracted .result does");
{
  const blob = '{"result":"VERDICT: PASS","usage":{"input_tokens":1}}';
  const anchored = (s) => /^VERDICT: (PASS|FAIL|BLOCKED)/m.test(s);
  check(!anchored(blob), "raw one-line JSON blob fails the ^VERDICT: anchor (the footgun)");
  const extracted = JSON.parse(blob).result + "\n";
  check(anchored(extracted), "extracted .result matches ^VERDICT: — proving extraction is required, not optional");
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\nusage: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
