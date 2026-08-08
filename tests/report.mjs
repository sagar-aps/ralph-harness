// Tests for the 'ralph report' subcommand (#56).
// Seeds .ralph/ledger.jsonl with fixtures and asserts human + --json output.
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

    // Per-ticket: task-002
    const t2Block = out.slice(out.indexOf("task-002:"));
    check(/task-002:/.test(out), "report includes task-002 section");
    check(/rounds:\s*2\b/.test(t2Block), "task-002: 2 rounds");
    check(/builder_attempts:\s*2\b/.test(t2Block), "task-002: builder_attempts = 2 (1+1)");
    check(/reviewer_attempts:\s*2\b/.test(t2Block), "task-002: reviewer_attempts = 2 (1+1)");
    check(/quota_rejected:\s*3\b/.test(t2Block), "task-002: quota_rejected = 3 (3+0)");
    check(/claude:haiku/.test(t2Block), "task-002: reviewer claude:haiku seen");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 2) --json output ──────────────────────────────────────────────────
console.log("2) --json emits stable sorted-key JSON with correct aggregates");
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

    // task-002
    const t2 = data.tickets.find((t) => t.round === "task-002");
    check(t2 && t2.rounds === 2 && t2.quota_rejected === 3, "JSON: task-002 aggregates correctly");
    check(t2 && t2.tokens.total === 6050, "JSON: task-002 total = 6050");

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

console.log(`\nreport: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
