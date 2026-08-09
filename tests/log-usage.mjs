// Tests for `ralph log-usage` (#70) — the driver/orchestrator ingestion hook.
// It turns the usage JSON a driver's own CLI prints into ONE role:driver ledger
// line, so the orchestrator's (often largest) consumption stops being invisible.
// Nothing here dispatches an agent: fixtures stand in for the CLI output.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
  const target = mkdtempSync(path.join(tmpdir(), "ralph-log-usage-"));
  mkdirSync(path.join(target, ".ralph"), { recursive: true });
  return target;
}

function ralph(args, opts = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, RALPH_SKIP_UPDATE_CHECK: "1", RALPH_NO_LOCAL_CONFIG: "1" },
    ...opts,
  });
}

const ledgerPath = (target) => path.join(target, ".ralph", "ledger.jsonl");
function ledgerLines(target) {
  const file = ledgerPath(target);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// The claude family's `--output-format json` result object.
const claudeUsage = {
  type: "result",
  result: "done",
  modelUsage: { "claude-opus-4-5": { inputTokens: 12000 } },
  usage: {
    input_tokens: 12000,
    output_tokens: 900,
    cache_read_input_tokens: 40000,
    cache_creation_input_tokens: 1000,
  },
};

// `codex --json`: usage rides the FINAL turn.completed event of the stream.
const codexJsonl = [
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5000, output_tokens: 400, cached_input_tokens: 2000, cache_write_input_tokens: null } }),
].join("\n") + "\n";

// ── 1) claude-shaped usage JSON ───────────────────────────────────────
console.log("1) A claude --output-format json result becomes one role:driver ledger line");
{
  const target = makeTarget();
  const usageFile = path.join(target, "driver.json");
  writeFileSync(usageFile, JSON.stringify(claudeUsage));
  try {
    const r = ralph(["log-usage", "--repo", target, "--role", "driver",
      "--pool", "anthropic", "--usage-json", usageFile]);
    check(r.status === 0, `log-usage exits 0 (got ${r.status}) ${r.stderr}`);
    const lines = ledgerLines(target);
    check(lines.length === 1, "exactly one line was appended");
    const rec = lines[0];
    check(rec.role === "driver", "role = driver");
    check(rec.pool === "anthropic", "pool = anthropic");
    check(rec.provider === "anthropic", "provider defaults to the pool name");
    check(rec.model === "claude-opus-4-5", "model comes from modelUsage");
    check(rec.round === "driver", 'round defaults to the "driver" pseudo-ticket');
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(rec.timestamp),
      `timestamp is ISO-8601 UTC (got ${rec.timestamp})`);
    check(rec.tokens.input === 12000 && rec.tokens.output === 900,
      "input/output tokens are recorded verbatim");
    check(rec.tokens.cached === 41000, "cached = cache_read + cache_creation");
    check(rec.tokens.total === 53900, "total = input + output + cached");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 2) codex JSONL: the final turn.completed wins ─────────────────────
console.log("2) codex --json JSONL: the FINAL turn.completed carries the usage");
{
  const target = makeTarget();
  const usageFile = path.join(target, "codex.jsonl");
  writeFileSync(usageFile, codexJsonl);
  try {
    const r = ralph(["log-usage", "--repo", target, "--role", "orchestrator",
      "--pool", "openai", "--usage-json", usageFile, "--round", "task-007",
      "--run-id", "run-Z", "--model", "gpt-5"]);
    check(r.status === 0, `log-usage exits 0 (got ${r.status}) ${r.stderr}`);
    const rec = ledgerLines(target)[0];
    check(rec.role === "orchestrator", "role = orchestrator is accepted too");
    check(rec.tokens.input === 5000 && rec.tokens.output === 400,
      "the last turn.completed wins over the earlier one");
    check(rec.tokens.cached === 2000, "a null cache-write field counts as 0");
    check(rec.tokens.total === 7400, "total = 5000 + 400 + 2000");
    check(rec.model === "gpt-5", "--model overrides what the JSON reports");
    check(rec.round === "task-007", "--round attributes the pass to a ticket");
    check(rec.run_id === "run-Z", "--run-id is recorded");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 3) The harness's own sidecar shape, and stdin ─────────────────────
console.log("3) A harness *.usage.json sidecar works, and - reads stdin");
{
  const target = makeTarget();
  const sidecar = JSON.stringify({ input: 700, output: 30, cache_read: 10, cache_creation: 5 });
  try {
    const r = ralph(["log-usage", "--repo", target, "--role", "driver",
      "--pool", "zai", "--usage-json", "-"], { input: sidecar });
    check(r.status === 0, `stdin log-usage exits 0 (got ${r.status}) ${r.stderr}`);
    const rec = ledgerLines(target)[0];
    check(rec.tokens.input === 700 && rec.tokens.output === 30, "sidecar fields are read");
    check(rec.tokens.cached === 15, "sidecar cache_read + cache_creation");
    check(rec.model === "unknown", "model stays unknown when nothing reports one");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 4) Bad input writes NOTHING ───────────────────────────────────────
console.log("4) Invalid input is rejected (exit 2) and never writes a ledger line");
{
  const target = makeTarget();
  const usageFile = path.join(target, "driver.json");
  writeFileSync(usageFile, JSON.stringify(claudeUsage));
  const cases = [
    [["--role", "builder", "--pool", "anthropic", "--usage-json", usageFile],
      "role=builder is refused (the loop already meters it)"],
    [["--role", "driver", "--usage-json", usageFile], "--pool is required"],
    [["--role", "driver", "--pool", "anthropic"], "--usage-json is required"],
    [["--pool", "anthropic", "--usage-json", usageFile], "--role is required"],
  ];
  try {
    for (const [args, msg] of cases) {
      const r = ralph(["log-usage", "--repo", target, ...args]);
      check(r.status === 2, `${msg} (exit 2, got ${r.status})`);
    }
    // Unusable usage JSON: valid JSON, no token counts anywhere.
    const noUsage = path.join(target, "no-usage.json");
    writeFileSync(noUsage, JSON.stringify({ result: "done" }));
    const r1 = ralph(["log-usage", "--repo", target, "--role", "driver",
      "--pool", "anthropic", "--usage-json", noUsage]);
    check(r1.status === 2, `a JSON with no token counts exits 2 (got ${r1.status})`);
    check(/token counts/.test(`${r1.stderr}`), "…and says why");

    const garbage = path.join(target, "garbage.txt");
    writeFileSync(garbage, "not json at all\n");
    const r2 = ralph(["log-usage", "--repo", target, "--role", "driver",
      "--pool", "anthropic", "--usage-json", garbage]);
    check(r2.status === 2, `unparseable input exits 2 (got ${r2.status})`);

    const r3 = ralph(["log-usage", "--repo", target, "--role", "driver",
      "--pool", "anthropic", "--usage-json", path.join(target, "missing.json")]);
    check(r3.status === 2, `a missing usage file exits 2 (got ${r3.status})`);

    check(ledgerLines(target).length === 0, "no ledger line was written by any rejected call");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 5) Append-only: existing lines are untouched ──────────────────────
console.log("5) The hook appends — existing ledger lines are left byte-identical");
{
  const target = makeTarget();
  const existing =
    JSON.stringify({
      run_id: "run-A", target, round: "task-001", timestamp: "2026-01-01T00:00:00Z",
      agents: { builder: { provider: "claude", requested_model: "sonnet", role: "builder" },
        reviewer: { provider: "claude", requested_model: "haiku", role: "reviewer" } },
      invocations: { builder_attempts: 1, reviewer_attempts: 1, quota_rejected: 0 },
      tokens: { input: 1000, output: 200, cached: 0, total: 1200 },
    }) + "\n";
  writeFileSync(ledgerPath(target), existing);
  const usageFile = path.join(target, "driver.json");
  writeFileSync(usageFile, JSON.stringify(claudeUsage));
  try {
    const r = ralph(["log-usage", "--repo", target, "--role", "driver",
      "--pool", "anthropic", "--usage-json", usageFile, "--round", "task-001"]);
    check(r.status === 0, `log-usage exits 0 (got ${r.status})`);
    const after = readFileSync(ledgerPath(target), "utf-8");
    check(after.startsWith(existing), "the pre-existing line is unchanged and still first");
    check(ledgerLines(target).length === 2, "one line was added");

    // And the report now shows both roles, with the driver on its own pool.
    const rep = ralph(["report", "--repo", target, "--json"]);
    check(rep.status === 0, "report --json exits 0");
    const data = JSON.parse(`${rep.stdout}`);
    const roles = data.by_role.map((x) => x.role).sort();
    check(roles.join(",") === "builder+reviewer,driver",
      `report breaks the ledger out into both roles (got ${roles.join(",")})`);
    const driverRow = data.by_role.find((x) => x.role === "driver");
    check(driverRow.pools.map((p) => p.pool).join(",") === "anthropic",
      "the driver row is broken out by pool");
    check(driverRow.tokens.total === 53900, "the driver row carries the logged tokens");
    const ticket = data.tickets.find((t) => t.round === "task-001");
    check(ticket.tokens.total === 1200 + 53900,
      "--round folds the driver pass into that ticket's total");
  } finally { rmSync(target, { recursive: true, force: true }); }
}

// ── 6) Discoverability ────────────────────────────────────────────────
console.log("6) --help documents the hook");
{
  const r = ralph(["--help"]);
  check(r.status === 0, "--help exits 0");
  check(/log-usage --role driver --pool/.test(`${r.stdout}`), "--help lists log-usage");
  check(/--usage-json/.test(`${r.stdout}`), "--help documents --usage-json");
}

console.log(`\nlog-usage: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
