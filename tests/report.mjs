// Tests for the 'ralph report' subcommand (#56, extended for #57 pricing).
// Seeds .ralph/ledger.jsonl with fixtures and asserts human + --json output
// including per-provider cost computation (issue-57).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

function makeTarget() {
  const target = mkdtempSync(path.join(tmpdir(), "ralph-report-"));
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  return target;
}

function ralph(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", ...env },
  });
}

// Fixture: 2 runs x 2 tickets with known numbers.
// task-001: 2 rounds total (1 per run), task-002: 2 rounds total (1 per run)
//
// Expected costs (issue-57, rates from pricing.json):
//   Line 1 (claude→anthropic, input=5000 out=800 cached=200):
//     5000/1M*3.00 + 800/1M*15.00 + 200/1M*0.30 = 0.027060
//   Line 2 (claude→anthropic, input=3000 out=500 cached=100):
//     3000/1M*3.00 + 500/1M*15.00 + 100/1M*0.30 = 0.016530
//   Line 3 (codex→openai, input=7000 out=1200 cached=0):
//     7000/1M*2.50 + 1200/1M*10.00 = 0.029500
//   Line 4 (codex→openai, input=2000 out=300 cached=150):
//     2000/1M*2.50 + 300/1M*10.00 + 150/1M*1.25 = 0.008188 (rounds from 0.0081875)
//   task-001 total: 0.027060 + 0.029500 = 0.056560
//   task-002 total: 0.016530 + 0.008188 = 0.024718
//   grand total:    0.056560 + 0.024718 = 0.081278
function seedLedger(target) {
  const lines = [
    // Run A, task-001
    {
      run_id: "run-A",
      target: target,
      round: "task-001",
      timestamp: "2026-01-01T00:00:00Z",
      agents: {
        builder: { provider: "claude", requested_model: "sonnet", reported_model: "claude-sonnet-4-20250514", model_match: "mismatch", role: "builder" },
        reviewer: { provider: "codex", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "reviewer" },
      },
      invocations: { builder_attempts: 2, reviewer_attempts: 1, quota_rejected: 0 },
      tokens: { input: 5000, output: 800, cached: 200, total: 6000 },
    },
    // Run A, task-002
    {
      run_id: "run-A",
      target: target,
      round: "task-002",
      timestamp: "2026-01-01T01:00:00Z",
      agents: {
        builder: { provider: "claude", requested_model: "sonnet", reported_model: "claude-sonnet-4-20250514", model_match: "mismatch", role: "builder" },
        reviewer: { provider: "claude", requested_model: "haiku", reported_model: "claude-haiku-4-5-20251001", model_match: "mismatch", role: "reviewer" },
      },
      invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 3 },
      tokens: { input: 3000, output: 500, cached: 100, total: 3600 },
    },
    // Run B, task-001
    {
      run_id: "run-B",
      target: target,
      round: "task-001",
      timestamp: "2026-01-02T00:00:00Z",
      agents: {
        builder: { provider: "codex", requested_model: "gpt-5", reported_model: "unknown", model_match: "unknown", role: "builder" },
        reviewer: { provider: "codex", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "reviewer" },
      },
      invocations: { builder_attempts: 3, reviewer_attempts: 2, quota_rejected: 1 },
      tokens: { input: 7000, output: 1200, cached: 0, total: 8200 },
    },
    // Run B, task-002
    {
      run_id: "run-B",
      target: target,
      round: "task-002",
      timestamp: "2026-01-02T01:00:00Z",
      agents: {
        builder: { provider: "codex", requested_model: "gpt-5", reported_model: "unknown", model_match: "unknown", role: "builder" },
        reviewer: { provider: "codex", requested_model: "gpt-5", reported_model: "unknown", model_match: "unknown", role: "reviewer" },
      },
      invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
      tokens: { input: 2000, output: 300, cached: 150, total: 2450 },
    },
  ];

  const ledger = path.join(target, ".ralph", "ledger.jsonl");
  writeFileSync(ledger, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return target;
}

// ── 1) Human-readable report ──────────────────────────────────────────
console.log("1) Human-readable report aggregates per-ticket across runs");
{
  const target = seedLedger(makeTarget());
  try {
    const r = ralph(["report", "--repo", target]);
    const out = `${r.stdout}`;
    check(r.status === 0, `report exits 0 (got ${r.status})`);

    // Top-line run count
    check(/runs:\s*2\b/.test(out), "top-line shows 2 distinct runs");

    // Grand totals
    check(/builder_attempts:\s*7\b/.test(out), "grand builder_attempts = 7 (2+1+3+1)");
    check(/reviewer_attempts:\s*5\b/.test(out), "grand reviewer_attempts = 5 (1+1+2+1)");
    check(/quota_rejected:\s*4\b/.test(out), "grand quota_rejected = 4 (0+3+1+0)");
    check(/input:\s*17000\b/.test(out), "grand input tokens = 17000");
    check(/output:\s*2800\b/.test(out), "grand output tokens = 2800");
    check(/cached:\s*450\b/.test(out), "grand cached tokens = 450");
    check(/total:\s*20250\b/.test(out), "grand total tokens = 20250");

    // Grand cost (issue-57: tokens × provider rates)
    check(/\$0\.081278/.test(out), "grand cost_usd = $0.081278 (anthropic+openai rates)");

    // Per-ticket: task-001 (2 rounds across runs)
    check(/task-001:/.test(out), "report includes task-001 section");
    const t1Block = out.slice(out.indexOf("task-001:"), out.indexOf("task-002:"));
    check(/rounds:\s*2\b/.test(t1Block), "task-001: 2 rounds (one per run)");
    check(/builder_attempts:\s*5\b/.test(t1Block), "task-001: builder_attempts = 5 (2+3)");
    check(/reviewer_attempts:\s*3\b/.test(t1Block), "task-001: reviewer_attempts = 3 (1+2)");
    check(/quota_rejected:\s*1\b/.test(t1Block), "task-001: quota_rejected = 1 (0+1)");
    check(/input:\s*12000\b/.test(t1Block), "task-001: input tokens = 12000");
    check(/claude:sonnet/.test(t1Block), "task-001: builder claude:sonnet seen");
    check(/codex:gpt-5/.test(t1Block), "task-001: builder codex:gpt-5 seen");
    check(/\$0\.05656/.test(t1Block), "task-001: cost_usd = $0.056560");

    // Per-ticket: task-002
    const t2Block = out.slice(out.indexOf("task-002:"));
    check(/task-002:/.test(out), "report includes task-002 section");
    check(/rounds:\s*2\b/.test(t2Block), "task-002: 2 rounds");
    check(/builder_attempts:\s*2\b/.test(t2Block), "task-002: builder_attempts = 2 (1+1)");
    check(/reviewer_attempts:\s*2\b/.test(t2Block), "task-002: reviewer_attempts = 2 (1+1)");
    check(/quota_rejected:\s*3\b/.test(t2Block), "task-002: quota_rejected = 3 (3+0)");
    check(/claude:haiku/.test(t2Block), "task-002: reviewer claude:haiku seen");
    check(/\$0\.024718/.test(t2Block), "task-002: cost_usd = $0.024718");

    // Cost providers reported
    check(/cost providers:.*anthropic.*openai/.test(t1Block), "task-001: cost providers list includes anthropic and openai");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 2) --json output ──────────────────────────────────────────────────
console.log("2) --json emits stable sorted-key JSON with correct aggregates (incl. cost)");
{
  const target = seedLedger(makeTarget());
  try {
    const r = ralph(["report", "--repo", target, "--json"]);
    const out = `${r.stdout}`.trim();
    check(r.status === 0, `report --json exits 0 (got ${r.status})`);

    let data;
    try { data = JSON.parse(out); } catch { check(false, "--json output is valid JSON"); }
    if (!data) { rmSync(target, { recursive: true, force: true }); process.exit(1); }

    check(data.runs === 2, "JSON: runs = 2");
    check(data.builder_attempts === 7, "JSON: grand builder_attempts = 7");
    check(data.reviewer_attempts === 5, "JSON: grand reviewer_attempts = 5");
    check(data.quota_rejected === 4, "JSON: grand quota_rejected = 4");
    check(data.tokens.input === 17000, "JSON: tokens.input = 17000");
    check(data.tokens.output === 2800, "JSON: tokens.output = 2800");
    check(data.tokens.cached === 450, "JSON: tokens.cached = 450");
    check(data.tokens.total === 20250, "JSON: tokens.total = 20250");
    check(data.cost_usd === 0.081278, "JSON: grand cost_usd = 0.081278");
    check(Array.isArray(data.tickets) && data.tickets.length === 2, "JSON: 2 tickets");

    // Verify sorted keys in serialized form (top-level keys are sorted)
    const topKeys = Object.keys(data);
    for (let i = 1; i < topKeys.length; i++) {
      check(topKeys[i] > topKeys[i - 1], `JSON keys sorted: ${topKeys[i - 1]} < ${topKeys[i]}`);
    }

    // task-001
    const t1 = data.tickets.find((t) => t.round === "task-001");
    check(t1 && t1.rounds === 2 && t1.builder_attempts === 5, "JSON: task-001 aggregates correctly");
    check(t1 && t1.tokens.cached === 200, "JSON: task-001 cached = 200");
    check(t1 && t1.cost_usd === 0.05656, "JSON: task-001 cost_usd = 0.05656");
    check(t1 && Array.isArray(t1.cost_providers) && t1.cost_providers.includes("anthropic") && t1.cost_providers.includes("openai"),
      "JSON: task-001 cost_providers = [anthropic, openai]");

    // task-002
    const t2 = data.tickets.find((t) => t.round === "task-002");
    check(t2 && t2.rounds === 2 && t2.quota_rejected === 3, "JSON: task-002 aggregates correctly");
    check(t2 && t2.tokens.total === 6050, "JSON: task-002 total = 6050");
    check(t2 && t2.cost_usd === 0.024718, "JSON: task-002 cost_usd = 0.024718");

    // Provider+model lists are sorted
    if (t1) {
      check(Array.isArray(t1.builder_providers), "JSON: builder_providers is an array");
      for (let i = 1; i < t1.builder_providers.length; i++) {
        check(t1.builder_providers[i] > t1.builder_providers[i - 1],
          `builder_providers sorted: ${t1.builder_providers[i - 1]} < ${t1.builder_providers[i]}`);
      }
    }
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 3) Absent ledger ──────────────────────────────────────────────────
console.log("3) Absent ledger prints 'no usage recorded yet' and exits 0");
{
  const target = makeTarget(); // no .ralph/ledger.jsonl
  try {
    const r = ralph(["report", "--repo", target]);
    check(r.status === 0, `absent ledger exits 0 (got ${r.status})`);
    check(/no usage recorded yet/.test(`${r.stdout}`.trim()), "prints 'no usage recorded yet'");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 4) Empty ledger ───────────────────────────────────────────────────
console.log("4) Empty ledger prints 'no usage recorded yet' and exits 0");
{
  const target = makeTarget();
  writeFileSync(path.join(target, ".ralph", "ledger.jsonl"), "");
  try {
    const r = ralph(["report", "--repo", target]);
    check(r.status === 0, `empty ledger exits 0 (got ${r.status})`);
    check(/no usage recorded yet/.test(`${r.stdout}`.trim()), "prints 'no usage recorded yet'");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 5) Malformed lines are skipped ────────────────────────────────────
console.log("5) Malformed JSON lines are skipped with a noted count, never fatal");
{
  const target = seedLedger(makeTarget());
  // Append some trash
  const ledger = path.join(target, ".ralph", "ledger.jsonl");
  writeFileSync(ledger,
    readFileSync(ledger, "utf-8") + "this is not json\n{broken\n\n" +
    "{\"run_id\":\"run-C\",\"target\":\"\",\"round\":\"task-003\",\"timestamp\":\"\",\"agents\":{},\"invocations\":{\"builder_attempts\":1,\"reviewer_attempts\":1,\"quota_rejected\":0},\"tokens\":{\"input\":100,\"output\":50,\"cached\":0,\"total\":150}}\n");
  try {
    const r = ralph(["report", "--repo", target]);
    const out = `${r.stdout}${r.stderr}`;
    check(r.status === 0, `report with malformed lines exits 0 (got ${r.status})`);
    check(/malformed line/.test(out), "malformed lines noted in output");
    // task-003 should still be included (it's valid JSON)
    check(/task-003/.test(out), "valid lines after malformed lines are still processed");
    check(/runs:\s*3\b/.test(out), "run-C counts as a distinct run");

    // --json also works with malformed lines
    const r2 = ralph(["report", "--repo", target, "--json"]);
    const sj = `${r2.stdout}`.trim();
    check(r2.status === 0, "report --json with malformed lines exits 0");
    const d = JSON.parse(sj);
    check(d.runs === 3, "JSON: 3 runs after malformed line skips");
    check(/malformed line/.test(`${r2.stderr}`), "stderr notes malformed line count");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 6) Read-only: ledger byte-identical after report ──────────────────
console.log("6) Report is read-only — ledger unchanged after running report");
{
  const target = seedLedger(makeTarget());
  try {
    const ledger = path.join(target, ".ralph", "ledger.jsonl");
    const before = readFileSync(ledger);
    ralph(["report", "--repo", target]);
    const after = readFileSync(ledger);
    check(before.equals(after), "ledger unchanged after report (human)");
    ralph(["report", "--repo", target, "--json"]);
    const afterJson = readFileSync(ledger);
    check(before.equals(afterJson), "ledger unchanged after report --json");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 7) Default repo = cwd ─────────────────────────────────────────────
console.log("7) report defaults to cwd when --repo is omitted");
{
  const target = seedLedger(makeTarget());
  try {
    const r = ralph(["report", "--repo", target]); // explicit --repo known-good first
    const r2 = spawnSync(process.execPath, [cliPath, "report"], {
      encoding: "utf-8",
      cwd: target,
      env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1", TARGET_REPO: "" },
    });
    check(r2.status === 0, "report with cwd default exits 0");
    check(/task-001/.test(`${r2.stdout}`), "report with cwd default finds the ledger");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 8) --help includes report subcommand ──────────────────────────────
console.log("8) --help lists the report subcommand");
{
  const r = ralph(["--help"]);
  check(r.status === 0, "--help exits 0");
  check(/report\s.*per-ticket/.test(`${r.stdout}`), "--help mentions report subcommand");
}

// ── 9) Unknown provider yields cost=unknown (issue-57) ────────────────
// Sections sort alphabetically: task-dlaude, task-known, task-unknown.
console.log("9) Unknown provider yields cost=unknown, tokens still reported");
{
  const target = makeTarget();
  const lines = [
    // Known provider (claude→anthropic)
    {
      run_id: "run-K",
      target: target,
      round: "task-known",
      timestamp: "2026-01-01T00:00:00Z",
      agents: {
        builder: { provider: "claude", requested_model: "sonnet", reported_model: "claude-sonnet-4-20250514", model_match: "mismatch", role: "builder" },
        reviewer: { provider: "claude", requested_model: "sonnet", reported_model: "claude-sonnet-4-20250514", model_match: "mismatch", role: "reviewer" },
      },
      invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
      tokens: { input: 1000, output: 200, cached: 0, total: 1200 },
    },
    // Unknown provider (droid — not in pricing table)
    {
      run_id: "run-K",
      target: target,
      round: "task-unknown",
      timestamp: "2026-01-01T01:00:00Z",
      agents: {
        builder: { provider: "droid", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "builder" },
        reviewer: { provider: "droid", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "reviewer" },
      },
      invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
      tokens: { input: 500, output: 100, cached: 0, total: 600 },
    },
    // Aliased provider (dlaude→deepseek)
    {
      run_id: "run-K",
      target: target,
      round: "task-dlaude",
      timestamp: "2026-01-01T02:00:00Z",
      agents: {
        builder: { provider: "dlaude", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "builder" },
        reviewer: { provider: "dlaude", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "reviewer" },
      },
      invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
      tokens: { input: 25081, output: 2, cached: 0, total: 25083 },
    },
  ];
  const ledger = path.join(target, ".ralph", "ledger.jsonl");
  writeFileSync(ledger, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    const r = ralph(["report", "--repo", target]);
    const out = `${r.stdout}`;
    check(r.status === 0, "unknown-provider report exits 0");

    // Grand cost is "unknown" because task-unknown has an unconfigured provider
    check(/cost_usd:\s+unknown/.test(out), "grand cost_usd = unknown (mixed known+unknown providers)");

    // task-dlaude: should use deepseek rates (via alias) — comes first alphabetically
    // 25081/1M*0.27 + 2/1M*1.10 = 0.00677187 + 0.0000022 = 0.00677407 → $0.006774
    check(/task-dlaude/.test(out), "task-dlaude section present");
    const dlaudeBlock = out.slice(out.indexOf("task-dlaude"), out.indexOf("task-known"));
    check(/\$0\.006774/.test(dlaudeBlock),
      "task-dlaude: cost = $0.006774 (deepseek rates via dlaude alias)");
    check(/cost providers:.*deepseek/.test(dlaudeBlock), "task-dlaude: cost provider = deepseek (via alias)");

    // task-known: should show a dollar cost (claude→anthropic)
    // 1000/1M*3.00 + 200/1M*15.00 = 0.003 + 0.003 = $0.006000
    check(/task-known/.test(out), "task-known section present");
    const knownBlock = out.slice(out.indexOf("task-known"), out.indexOf("task-unknown"));
    check(/\$0\.006000/.test(knownBlock),
      "task-known: cost = $0.006000 (1000*3.00 + 200*15.00)/1M");
    check(/cost providers:.*anthropic/.test(knownBlock), "task-known: cost provider = anthropic");

    // task-unknown: cost should be "unknown", tokens still reported — comes last alphabetically
    check(/task-unknown/.test(out), "task-unknown section present");
    const unknownBlock = out.slice(out.indexOf("task-unknown"));
    check(/cost_usd:\s+unknown/.test(unknownBlock), "task-unknown: cost_usd = unknown (droid is not in pricing)");
    check(/input:\s*500\b/.test(unknownBlock), "task-unknown: input tokens still shown (500)");
    check(/output:\s*100\b/.test(unknownBlock), "task-unknown: output tokens still shown (100)");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 10) JSON output for unknown/mixed providers (issue-57) ────────────
console.log("10) JSON output: unknown provider → cost_usd = 'unknown' string, known aliases resolved");
{
  const target = makeTarget();
  const lines = [
    {
      run_id: "run-X",
      target: target,
      round: "task-mix",
      timestamp: "2026-01-01T00:00:00Z",
      agents: {
        builder: { provider: "rlaude", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "builder" },
        reviewer: { provider: "rlaude", requested_model: "default", reported_model: "unknown", model_match: "unknown", role: "reviewer" },
      },
      invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
      tokens: { input: 100, output: 50, cached: 0, total: 150 },
    },
  ];
  const ledger = path.join(target, ".ralph", "ledger.jsonl");
  writeFileSync(ledger, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    const r = ralph(["report", "--repo", target, "--json"]);
    const out = `${r.stdout}`.trim();
    check(r.status === 0, "JSON unknown-provider report exits 0");

    const data = JSON.parse(out);
    check(data.cost_usd === "unknown", "JSON: grand cost_usd = 'unknown' (all unknown providers)");
    const t = data.tickets[0];
    check(t && t.cost_usd === "unknown", "JSON: ticket cost_usd = 'unknown' string");
    check(t && t.tokens.input === 100, "JSON: tokens still reported despite unknown cost");
    check(t && Array.isArray(t.cost_providers) && t.cost_providers.length === 0,
      "JSON: cost_providers is empty array for unknown providers");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

console.log(`\nreport: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
