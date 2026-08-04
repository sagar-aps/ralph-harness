// Tests for the provider-REPORTED model capture, layered on top of the #40
// per-attempt usage sidecar (see reported-model.sh + round-usage.sh).
//
// Claude-family `--output-format json` exposes a top-level `modelUsage` map keyed
// by model id (added so mixed-model sessions can be broken down per model). A
// single key is captured as the reported model and compared against the
// REQUESTED model pin (the `--model` flag on the backend command). Three cases:
// the pin matches what came back, the pin does NOT match (a routing mismatch,
// #27's Z.AI caveat), and no model id is exposed at all (must show "unknown",
// never fabricated).
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
  const target = mkdtempSync(path.join(tmpdir(), "ralph-repmodel-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "ralph-repmodel-plan-"));
  tmps.push(dir);
  writeFileSync(path.join(dir, "01-task.md"), "# Do a thing\nMake a change.\n");
  return dir;
}
function cleanup(target) {
  try { rmSync(wtBase(target), { recursive: true, force: true }); } catch {}
  rmSync(target, { recursive: true, force: true });
}
function fakeAgentDir() {
  const d = mkdtempSync(path.join(tmpdir(), "ralph-repmodel-agents-"));
  tmps.push(d);
  return d;
}
// A fake builder/reviewer that makes a real change (so the batch can commit and
// advance) and emits Claude-shaped JSON with a `modelUsage` map on stdout.
function writeJsonAgent(dir, name, { modelUsage, isReviewer }) {
  const p = path.join(dir, `${name}.sh`);
  const resultText = isReviewer ? "### Must-fix issues\\n- none\\n\\nVERDICT: PASS" : "did the thing";
  const body = `#!/usr/bin/env bash
${isReviewer ? "" : 'echo "change $$-$RANDOM" >> built.txt\nprintf \'# handoff\\n- did the thing\\n\' > .agent-handoff.md'}
cat <<JSON
{"result":"${resultText}","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}${
    modelUsage ? `,"modelUsage":${JSON.stringify(modelUsage)}` : ""
  }}
JSON
`;
  writeScript(p, body);
  return p;
}

// NB: does NOT clean up the target — callers that only need `out`/`usageLine`/
// `record` should call `cleanup(result.target)` themselves; callers that also need
// to inspect artifact files under `result.rd` must do so BEFORE cleaning up.
function runOne(label, { builderModelUsage, builderRequestedModel, reviewerModelUsage, reviewerRequestedModel }) {
  console.log(label);
  const target = makeTarget();
  const plan = planOneTask();
  const dir = fakeAgentDir();
  const bScript = writeJsonAgent(dir, "b", { modelUsage: builderModelUsage, isReviewer: false });
  const rScript = writeJsonAgent(dir, "r", { modelUsage: reviewerModelUsage, isReviewer: true });
  const r = ralph(
    ["batch", "--repo", target, "--plan", plan, "--builder", "brm", "--reviewer", "rrm", "--auto-approve-builder"],
    {
      RALPH_AGENT_RETRY_DELAY: "0",
      RALPH_WORKTREE_DIR: wtBase(target),
      AGENT_BRM_CMD: builderRequestedModel ? `${bScript} --model ${builderRequestedModel}` : bScript,
      AGENT_RRM_CMD: reviewerRequestedModel ? `${rScript} --model ${reviewerRequestedModel}` : rScript,
    },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(r.status === 0, `batch exits 0 (got ${r.status})`);
  const rd = runDirOf(target);
  const usageLines = out.split("\n").filter((line) => line.startsWith("USAGE "));
  check(usageLines.length === 1, "round emits exactly one USAGE line");
  const roundUsage = path.join(rd, "round-usage.jsonl");
  const record = existsSync(roundUsage)
    ? JSON.parse(readFileSync(roundUsage, "utf-8").trim().split("\n").pop())
    : null;
  return { out, usageLine: usageLines[0] || "", record, rd, target };
}

console.log("1) MATCH: reported model equals the requested pin");
{
  const { usageLine, record, target } = runOne("  builder pinned + provider reports the same model", {
    builderRequestedModel: "fixture-sonnet",
    builderModelUsage: { "fixture-sonnet": { inputTokens: 10, outputTokens: 5 } },
  });
  check(/builder_reported_model=fixture-sonnet/.test(usageLine), `USAGE line carries the reported model (${usageLine})`);
  check(/builder_model_match=match/.test(usageLine), `USAGE line marks the pin as matched (${usageLine})`);
  check(!/ralph: NOTE:.*routing mismatch/i.test(usageLine), "no mismatch note embedded in the USAGE line itself");
  if (record) {
    check(record.agents.builder.reported_model === "fixture-sonnet", "artifact records the reported model");
    check(record.agents.builder.model_match === "match", "artifact records a match verdict");
  } else { check(false, "round-usage.jsonl record exists"); }
  cleanup(target);
}

console.log("2) MISMATCH: provider reports a model different from the requested pin");
{
  const { out, usageLine, record, target } = runOne("  builder pinned to one model, provider reports another (routing mismatch)", {
    builderRequestedModel: "fixture-sonnet",
    builderModelUsage: { "fixture-haiku": { inputTokens: 10, outputTokens: 5 } },
  });
  check(/builder_reported_model=fixture-haiku/.test(usageLine), `USAGE line carries the actually-reported model (${usageLine})`);
  check(/builder_model_match=mismatch/.test(usageLine), `USAGE line flags the mismatch (${usageLine})`);
  check(/routing mismatch/i.test(out), "a routing-mismatch note is surfaced (honors the #27 Z.AI caveat)");
  check(/requested model 'fixture-sonnet'/.test(out) && /reported 'fixture-haiku'/.test(out),
    "the note names both the requested pin and what actually came back");
  if (record) {
    check(record.agents.builder.reported_model === "fixture-haiku", "artifact records the mismatched reported model");
    check(record.agents.builder.model_match === "mismatch", "artifact records a mismatch verdict");
  } else { check(false, "round-usage.jsonl record exists"); }
  cleanup(target);
}

console.log("3) ABSENT: no model id in the usage JSON at all -> unknown, never fabricated");
{
  const { usageLine, record, target } = runOne("  provider JSON carries no modelUsage field", {
    builderRequestedModel: "fixture-sonnet",
    builderModelUsage: null,
  });
  check(/builder_reported_model=unknown/.test(usageLine), `USAGE line shows unknown, not a guess (${usageLine})`);
  check(/builder_model_match=unknown/.test(usageLine), `match verdict is unknown, not fabricated (${usageLine})`);
  if (record) {
    check(record.agents.builder.reported_model === "unknown", "artifact records unknown reported model");
    check(record.agents.builder.model_match === "unknown", "artifact records unknown match verdict");
  } else { check(false, "round-usage.jsonl record exists"); }
  cleanup(target);
}

console.log("4) NO PIN REQUESTED: a reported model with no requested pin is 'unknown', not a mismatch");
{
  const { usageLine, target } = runOne("  no --model flag on the builder command at all", {
    builderModelUsage: { "fixture-sonnet": { inputTokens: 10, outputTokens: 5 } },
  });
  check(/builder_model=default/.test(usageLine), `no pin was requested (${usageLine})`);
  check(/builder_reported_model=fixture-sonnet/.test(usageLine), "the reported model is still captured");
  check(/builder_model_match=unknown/.test(usageLine), "an unset pin cannot be a confirmed match or a mismatch");
  cleanup(target);
}

console.log("5) #40 sidecar is untouched by reported-model capture");
{
  const { rd, target } = runOne("  usage.json still has the original #40 shape, unaffected by the new .model.json sidecar", {
    builderRequestedModel: "fixture-sonnet",
    builderModelUsage: { "fixture-sonnet": { inputTokens: 10, outputTokens: 5 } },
  });
  const usageSide = path.join(rd, "task-001-iter-1-builder.usage.json");
  check(existsSync(usageSide), "#40 usage sidecar still written");
  if (existsSync(usageSide)) {
    const u = JSON.parse(readFileSync(usageSide, "utf-8"));
    check(u.input === 10 && u.output === 5, "usage sidecar keeps its original numeric fields");
    check(!("model" in u), "the #40 sidecar shape is not modified to carry the model (kept in its own file)");
  }
  const modelSide = path.join(rd, "task-001-iter-1-builder.model.json");
  check(existsSync(modelSide), "reported-model sidecar written alongside the usage sidecar");
  if (existsSync(modelSide)) {
    const m = JSON.parse(readFileSync(modelSide, "utf-8"));
    check(m.model === "fixture-sonnet", "reported-model sidecar carries the model id");
  }
  cleanup(target);
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\nreported-model: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
