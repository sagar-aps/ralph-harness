// Prompt-cache prefix stability gate (#32).
//
// Provider prefix caches only hit on an EXACT byte prefix, and only above a minimum
// length. Two properties therefore have to hold, and neither is implied by the other:
//
//   1. IDENTITY — the stable block must not shift between attempts, and must not shift
//      between runs. OpenAI additionally routes on a hash of roughly the FIRST 256
//      TOKENS, so a dynamic token in that window is not a shortened prefix, it is a
//      different cache bucket entirely.
//   2. LENGTH — the shared prefix must clear the provider minimum (1024 tokens for
//      OpenAI/Z.AI and most Anthropic models). A byte-identical 811-token prefix passes
//      an identity check and still caches NOWHERE — that was the pre-#32 state, which
//      is exactly why identity alone is not a sufficient gate.
//
// Regression this pins specifically: `{{MAX_ITERATIONS}}` used to render inside the
// intro prose at ~110 tokens, ahead of the primer. Two runs with different
// --max-iterations therefore landed in different OpenAI cache buckets. Test 3 below
// varies --max-iterations across runs on purpose; a template that reintroduces an
// attempt-budget token above the boundary will fail it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "ralph");

// Provider minimum cacheable prefix, in tokens (OpenAI/Z.AI/most Anthropic models).
const MIN_CACHEABLE_TOKENS = 1024;
// OpenAI's cache-key routing window, in tokens.
const KEY_WINDOW_TOKENS = 256;
// Conservative chars-per-token for English prose + markdown. Real tokenizers land
// near 4; 4 keeps the byte thresholds honest without pulling in a tokenizer dep.
const CHARS_PER_TOKEN = 4;
const MIN_PREFIX_BYTES = MIN_CACHEABLE_TOKENS * CHARS_PER_TOKEN;
const KEY_WINDOW_BYTES = KEY_WINDOW_TOKENS * CHARS_PER_TOKEN;

const BOUNDARY = "================== DYNAMIC BOUNDARY ==================";

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
function wtBase(target) { return path.join(target, "..", `ralph-wt-${path.basename(target)}`); }
function cleanup(target) {
  try { rmSync(wtBase(target), { recursive: true, force: true }); } catch {}
  rmSync(target, { recursive: true, force: true });
}
function makeTarget() {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-cacheprefix-"));
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "t"]);
  writeFileSync(path.join(target, "README.md"), "# T\n");
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  writeScript(path.join(target, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(
    path.join(target, "ralph.target.json"),
    JSON.stringify({ check: "./scripts/check.sh", preview: { enabled: false } }, null, 2),
  );
  writeFileSync(path.join(target, ".gitignore"), ".ralph/\n.agent-run/\n.agent-handoff.md\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "init"]);
  return target;
}
function onePlan() {
  const dir = mkdtempSync(path.join(tmpdir(), "ralph-cacheplan-"));
  writeFileSync(path.join(dir, "01.md"), "# Task one\nAppend a line to progress.txt.\n");
  return dir;
}
// A primer big enough that the stable prefix can clear the provider minimum. A real
// batch supplies one; without it no ordering can reach 1024 tokens on a small prompt
// (see docs/kv-cache-analysis.md Finding 4).
function makePrimer() {
  const dir = mkdtempSync(path.join(tmpdir(), "ralph-cacheprimer-"));
  const p = path.join(dir, "primer.md");
  const body = Array.from(
    { length: 60 },
    (_, i) => `- module_${i}: lives under src/module_${i}/, owns the module_${i} boundary and its tests.`,
  ).join("\n");
  writeFileSync(p, `# Repo map\n\nStable orientation for every attempt in this run.\n\n${body}\n`);
  return { dir, file: p };
}
function latestRunDir(target) {
  const root = path.join(target, ".agent-run");
  const dirs = readdirSync(root).filter((x) => x.startsWith("batch-")).sort();
  return path.join(root, dirs[dirs.length - 1]);
}
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

const FB = 'bash -c "echo x >> progress.txt; printf \\"# handoff\\n\\" > .agent-handoff.md"';
// Always FAIL, so the same task renders attempt 1 and attempt 2 prompts.
const FAILREV = 'bash -c "printf \\"### Must-fix issues\\n- do it again\\n\\nVERDICT: FAIL\\n\\""';

// Render a batch and return the run dir. maxIter drives how many attempts happen.
function renderRun(target, plan, primerFile, maxIter) {
  const r = ralph(
    ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "failrev",
      "--primer", primerFile, "--auto-approve-builder", "--max-tasks", "1",
      "--max-iterations", String(maxIter)],
    {
      RALPH_AGENT_RETRY_DELAY: "0",
      // NOT dry-run: RALPH_DRY_RUN=1 skips the agent backends, so the reviewer never
      // emits its FAIL and no second attempt is rendered. The fake backends below are
      // what keep this test provider-free.
      RALPH_DRY_RUN: "",
      RALPH_WORKTREE_DIR: wtBase(target),
      AGENT_FB_CMD: FB,
      AGENT_FAILREV_CMD: FAILREV,
    },
  );
  return { out: `${r.stdout}${r.stderr}`, runDir: latestRunDir(target) };
}

console.log("1) builder prompt: stable prefix is byte-identical ACROSS ATTEMPTS");
{
  const target = makeTarget();
  const plan = onePlan();
  const primer = makePrimer();
  try {
    const { runDir } = renderRun(target, plan, primer.file, 2);
    const p1 = readFileSync(path.join(runDir, "task-001-iter-1-builder-prompt.md"), "utf-8");
    const p2 = readFileSync(path.join(runDir, "task-001-iter-2-builder-prompt.md"), "utf-8");

    check(p1.includes(BOUNDARY) && p2.includes(BOUNDARY), "both attempts carry the dynamic boundary marker");

    const b1 = p1.indexOf(BOUNDARY);
    const shared = commonPrefixLen(p1, p2);
    check(shared >= b1, `shared prefix (${shared} B) reaches the boundary (at ${b1} B)`);
    check(
      p1.slice(0, b1) === p2.slice(0, b1),
      "everything above the boundary is byte-identical between attempt 1 and attempt 2",
    );

    // LENGTH: identity alone is not enough — it must clear the provider minimum.
    check(
      shared >= MIN_PREFIX_BYTES,
      `shared prefix ${shared} B >= ${MIN_PREFIX_BYTES} B (~${MIN_CACHEABLE_TOKENS} tok provider minimum)`,
    );

    // The attempt counter and previous-attempt feedback must live BELOW the boundary.
    check(p2.indexOf("Attempt 2 of 2") > b1, "attempt counter renders below the boundary");
    check(p2.indexOf("do it again") > b1, "previous reviewer feedback renders below the boundary");
    check(!p1.slice(0, b1).includes("Attempt "), "no attempt counter above the boundary");

    // Nothing lost in the reorder.
    check(!/\{\{[A-Z_]+\}\}/.test(p2), "no unsubstituted {{VAR}} tokens remain");
    check(p2.includes("Append a line to progress.txt"), "task content still rendered");
    check(p2.includes("Rules (non-negotiable)"), "non-negotiable rules still rendered");
    check(p2.includes("Repo map"), "primer still rendered");
    check(p2.includes("Handoff file format"), "handoff format still rendered");
  } finally {
    cleanup(target);
    rmSync(plan, { recursive: true, force: true });
    rmSync(primer.dir, { recursive: true, force: true });
  }
}

console.log("2) reviewer prompt: stable prefix is byte-identical ACROSS ATTEMPTS");
{
  const target = makeTarget();
  const plan = onePlan();
  const primer = makePrimer();
  try {
    const { runDir } = renderRun(target, plan, primer.file, 2);
    const r1 = readFileSync(path.join(runDir, "task-001-iter-1-reviewer-prompt.md"), "utf-8");
    const r2 = readFileSync(path.join(runDir, "task-001-iter-2-reviewer-prompt.md"), "utf-8");

    check(r1.includes(BOUNDARY) && r2.includes(BOUNDARY), "both reviewer prompts carry the boundary marker");
    const b1 = r1.indexOf(BOUNDARY);
    check(r1.slice(0, b1) === r2.slice(0, b1), "reviewer stable block is identical between attempts");
    check(r2.indexOf("Git diff produced by the builder") > b1, "git diff renders below the boundary");
    check(r2.indexOf("Check command output") > b1, "check output renders below the boundary");
    check(!/\{\{[A-Z_]+\}\}/.test(r2), "no unsubstituted {{VAR}} tokens remain");
    check(r2.includes("VERDICT: PASS"), "verdict vocabulary still rendered");
  } finally {
    cleanup(target);
    rmSync(plan, { recursive: true, force: true });
    rmSync(primer.dir, { recursive: true, force: true });
  }
}

console.log("3) builder prompt: cache-key window is byte-identical ACROSS RUNS");
{
  // Two separate runs => different RUN_ID, worktree path, and branch, AND a different
  // --max-iterations. The first ~256 tokens must still match, or OpenAI routes the two
  // runs to different cache buckets. This is the {{MAX_ITERATIONS}}-in-prose regression.
  const targetA = makeTarget();
  const targetB = makeTarget();
  const plan = onePlan();
  const primer = makePrimer();
  try {
    const a = renderRun(targetA, plan, primer.file, 2);
    const b = renderRun(targetB, plan, primer.file, 4);
    const pa = readFileSync(path.join(a.runDir, "task-001-iter-1-builder-prompt.md"), "utf-8");
    const pb = readFileSync(path.join(b.runDir, "task-001-iter-1-builder-prompt.md"), "utf-8");

    check(path.basename(a.runDir) !== path.basename(b.runDir), "the two runs really have distinct run ids");

    const shared = commonPrefixLen(pa, pb);
    check(
      shared >= KEY_WINDOW_BYTES,
      `cross-run shared prefix ${shared} B >= ${KEY_WINDOW_BYTES} B (~${KEY_WINDOW_TOKENS} tok cache-key window)`,
    );
    check(
      pa.slice(0, KEY_WINDOW_BYTES) === pb.slice(0, KEY_WINDOW_BYTES),
      "first ~256 tokens are byte-identical across runs with different --max-iterations",
    );
    // The run-scoped identifiers must not appear in the key window.
    const windowA = pa.slice(0, KEY_WINDOW_BYTES);
    check(!windowA.includes(path.basename(a.runDir)), "run id absent from the cache-key window");
    check(!/Attempt \d+ of \d+/.test(windowA), "attempt budget absent from the cache-key window");
  } finally {
    cleanup(targetA);
    cleanup(targetB);
    rmSync(plan, { recursive: true, force: true });
    rmSync(primer.dir, { recursive: true, force: true });
  }
}

console.log("4) PREVIOUS_REVIEW carries the reviewer's FINDINGS, not its raw stdout (#41)");
{
  const target = makeTarget();
  const plan = onePlan();
  const primer = makePrimer();
  // A reviewer that behaves like codex: echo the whole input prompt to stdout (so the
  // echo contains the template's OWN headings and VERDICT examples), then reply.
  const ECHOREV =
    'bash -c \'cat; printf "\\n### Must-fix issues\\n- SENTINEL-MUSTFIX tighten the regex\\n\\n### Evidence\\n- file.py:1\\n\\nVERDICT: FAIL\\n"\'';
  try {
    const r = ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "echorev",
        "--primer", primer.file, "--auto-approve-builder", "--max-tasks", "1", "--max-iterations", "2"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "", RALPH_WORKTREE_DIR: wtBase(target),
        AGENT_FB_CMD: FB, AGENT_ECHOREV_CMD: ECHOREV },
    );
    const runDir = latestRunDir(target);
    const raw = readFileSync(path.join(runDir, "task-001-iter-1-reviewer.md"), "utf-8");
    const fb = readFileSync(path.join(runDir, "task-001-iter-1-reviewer-feedback.md"), "utf-8");
    const p2 = readFileSync(path.join(runDir, "task-001-iter-2-builder-prompt.md"), "utf-8");

    check(raw.includes("Git diff produced by the builder"), "raw reviewer log did echo its input (fixture is representative)");
    check(fb.length < raw.length / 2, `feedback is much smaller than raw stdout (${fb.length} B vs ${raw.length} B)`);
    check(fb.trimStart().startsWith("### Must-fix issues"), "feedback starts at the findings block, not the echoed template");
    check(fb.includes("SENTINEL-MUSTFIX"), "the actual must-fix item survived");
    check(fb.trimEnd().endsWith("VERDICT: FAIL"), "feedback ends at the verdict line");
    check(!fb.includes("Git diff produced by the builder"), "echoed git diff is NOT in the feedback");

    check(p2.includes("SENTINEL-MUSTFIX"), "the builder's retry prompt carries the must-fix item");
    check(!p2.includes("Git diff produced by the builder"), "the builder's retry prompt does NOT carry the echoed diff");
  } finally {
    cleanup(target);
    rmSync(plan, { recursive: true, force: true });
    rmSync(primer.dir, { recursive: true, force: true });
  }
}

console.log("5) unrecognisable reviewer output falls back to the raw log (never drop feedback)");
{
  const target = makeTarget();
  const plan = onePlan();
  const primer = makePrimer();
  // No findings headings at all — just a bare verdict plus prose.
  const BARE = 'bash -c \'printf "the diff is wrong in several places\\nVERDICT: FAIL\\n"\'';
  try {
    ralph(
      ["batch", "--repo", target, "--plan", plan, "--builder", "fb", "--reviewer", "barerev",
        "--primer", primer.file, "--auto-approve-builder", "--max-tasks", "1", "--max-iterations", "2"],
      { RALPH_AGENT_RETRY_DELAY: "0", RALPH_DRY_RUN: "", RALPH_WORKTREE_DIR: wtBase(target),
        AGENT_FB_CMD: FB, AGENT_BAREREV_CMD: BARE },
    );
    const runDir = latestRunDir(target);
    const fb = readFileSync(path.join(runDir, "task-001-iter-1-reviewer-feedback.md"), "utf-8");
    const p2 = readFileSync(path.join(runDir, "task-001-iter-2-builder-prompt.md"), "utf-8");
    check(fb.includes("the diff is wrong"), "fell back to raw output rather than emitting nothing");
    check(p2.includes("the diff is wrong"), "builder still receives the feedback on retry");
  } finally {
    cleanup(target);
    rmSync(plan, { recursive: true, force: true });
    rmSync(primer.dir, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll prompt-cache-prefix checks passed");
