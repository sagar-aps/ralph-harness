// Fixture tests for identity resolution (.agents/ralph/resolve-identity.sh).
// Tests the resolution order: marker -> $RALPH_IDENTITY_WRAPPER -> .agents/ralph/identity.sh -> ambient gh
// Hermetic: uses fake wrappers and git repos, no real gh/secrets required.
import { writeFileSync, mkdirSync, mkdtempSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", ".agents", "ralph", "resolve-identity.sh");
const work = mkdtempSync(join(tmpdir(), "identity-resolve-"));

let pass = 0, fail = 0;

// Create a fake git repo
function createFakeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "fake-repo-"));
  spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  return repo;
}

// Create a fake wrapper script
function createWrapper(path, content = "#!/usr/bin/env bash\necho 'wrapper invoked'\nexit 0\n") {
  writeFileSync(path, content, { mode: 0o755 });
}

// Create ralph.target.json with identity marker
function createTargetConfig(repo, { enabled = true, wrapper = "", role = "orchestrator" } = {}) {
  const config = { check: "./scripts/check.sh" };
  if (enabled !== undefined && wrapper !== undefined) {
    config.identity = { enabled, wrapper, role };
  } else if (enabled !== undefined) {
    // Marker enabled but no wrapper specified
    config.identity = { enabled };
  }
  writeFileSync(join(repo, "ralph.target.json"), JSON.stringify(config, null, 2));
}

function runResolve(repo, extraEnv = {}) {
  const result = spawnSync(
    "bash",
    ["-c", `source "${scriptPath}" && echo "WRAPPER=$RESOLVED_WRAPPER" && echo "STATUS=$IDENTITY_STATUS" && echo "SOURCE=$IDENTITY_SOURCE"`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TARGET_REPO: repo,
        RALPH_TEST_IDENTITY_RESOLVE: "1",
        ...extraEnv,
      },
    }
  );

  const output = result.stdout || "";
  const wrapper = (output.match(/WRAPPER=(.*)/m) || [])[1] || "";
  const status = (output.match(/STATUS=(.*)/m) || [])[1] || "";
  const source = (output.match(/SOURCE=(.*)/m) || [])[1] || "";

  return { wrapper, status, source, stdout: output, stderr: result.stderr || "", exitCode: result.status };
}

function expectResult(label, result, expected) {
  const ok = result.wrapper === (expected.wrapper || "") &&
            result.status === (expected.status || "") &&
            result.source === (expected.source || "");
  console.log(`  ${ok ? "✔" : "✗"} ${label}`);
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`      Expected: ${JSON.stringify(expected)}`);
    console.log(`      Got: wrapper=${result.wrapper} status=${result.status} source=${result.source}`);
    console.log(`      stdout: ${result.stdout}`);
    console.log(`      stderr: ${result.stderr}`);
  }
}

console.log("identity-resolution fixture tests");
console.log("1) Absent marker: normal fallback (no degraded warning)");

const repo1 = createFakeRepo();
// No ralph.target.json at all
let r = runResolve(repo1);
expectResult("no config file → fallback", r, { wrapper: "", status: "fallback", source: "default-not-found" });

// Config with identity.enabled=false
createTargetConfig(repo1, { enabled: false, wrapper: "/any", role: "orchestrator" });
r = runResolve(repo1);
expectResult("identity.enabled=false → fallback", r, { wrapper: "", status: "fallback", source: "default-not-found" });

console.log("\n2) Marker with working wrapper → resolved");

const repo2 = createFakeRepo();
const wrapper2 = join(work, "wrapper2.sh");
createWrapper(wrapper2);
createTargetConfig(repo2, { enabled: true, wrapper: wrapper2, role: "orchestrator" });
r = runResolve(repo2);
expectResult("marker+working wrapper → resolved", r, { wrapper: wrapper2, status: "resolved", source: "marker" });

console.log("\n3) Marker with failing wrapper → degraded");

const repo3 = createFakeRepo();
// Non-existent wrapper
createTargetConfig(repo3, { enabled: true, wrapper: "/nonexistent/wrapper.sh", role: "orchestrator" });
r = runResolve(repo3);
expectResult("marker+nonexistent wrapper → degraded", r, { wrapper: "", status: "degraded", source: "marker-not-found" });

// Non-executable wrapper
const repo4 = createFakeRepo();
const wrapper4 = join(work, "wrapper4.sh");
writeFileSync(wrapper4, "#!/usr/bin/env bash\necho 'not executable'\n", { mode: 0o644 });
createTargetConfig(repo4, { enabled: true, wrapper: wrapper4, role: "orchestrator" });
r = runResolve(repo4);
expectResult("marker+non-executable wrapper → degraded", r, { wrapper: "", status: "degraded", source: "marker-not-executable" });

console.log("\n4) $RALPH_IDENTITY_WRAPPER override (when marker absent)");

const repo5 = createFakeRepo();
const wrapper5 = join(work, "wrapper5.sh");
createWrapper(wrapper5);
r = runResolve(repo5, { RALPH_IDENTITY_WRAPPER: wrapper5 });
expectResult("env override (no marker) → resolved", r, { wrapper: wrapper5, status: "resolved", source: "env" });

console.log("\n5) $RALPH_IDENTITY_WRAPPER when marker present (marker wins)");

const repo6 = createFakeRepo();
const markerWrapper6 = join(work, "marker-wrapper6.sh");
const envWrapper6 = join(work, "env-wrapper6.sh");
createWrapper(markerWrapper6);
createWrapper(envWrapper6);
createTargetConfig(repo6, { enabled: true, wrapper: markerWrapper6, role: "orchestrator" });
r = runResolve(repo6, { RALPH_IDENTITY_WRAPPER: envWrapper6 });
expectResult("marker present → marker wins over env", r, { wrapper: markerWrapper6, status: "resolved", source: "marker" });

console.log("\n6) .agents/ralph/identity.sh default");

const repo7 = createFakeRepo();
const identitySh7 = join(repo7, ".agents", "ralph", "identity.sh");
mkdirSync(join(repo7, ".agents", "ralph"), { recursive: true });
createWrapper(identitySh7);
r = runResolve(repo7);
expectResult("default identity.sh → resolved", r, { wrapper: identitySh7, status: "resolved", source: "default" });

console.log("\n7) Resolution order precedence");

const repo8 = createFakeRepo();
// Set up all three: marker, env, default
const markerWrapper8 = join(work, "marker8.sh");
const envWrapper8 = join(work, "env8.sh");
const identitySh8 = join(repo8, ".agents", "ralph", "identity.sh");
mkdirSync(join(repo8, ".agents", "ralph"), { recursive: true });
createWrapper(markerWrapper8);
createWrapper(envWrapper8);
createWrapper(identitySh8);
createTargetConfig(repo8, { enabled: true, wrapper: markerWrapper8, role: "orchestrator" });
r = runResolve(repo8, { RALPH_IDENTITY_WRAPPER: envWrapper8 });
expectResult("all present → marker wins", r, { wrapper: markerWrapper8, status: "resolved", source: "marker" });

console.log("\n8) Marker enabled=false -> no degraded mode");

const repo9 = createFakeRepo();
createTargetConfig(repo9, { enabled: false, wrapper: "/any", role: "orchestrator" });
r = runResolve(repo9);
expectResult("marker enabled=false → fallback", r, { wrapper: "", status: "fallback", source: "default-not-found" });

console.log("\n9) Marker enabled but no wrapper field -> degraded");

const repo9b = createFakeRepo();
createTargetConfig(repo9b, { enabled: true, role: "orchestrator" });  // no wrapper field
r = runResolve(repo9b);
expectResult("marker enabled but no wrapper field → degraded", r, { wrapper: "", status: "degraded", source: "marker-no-wrapper" });

console.log("\n10) Env override failure with no marker -> fallback");

const repo10 = createFakeRepo();
r = runResolve(repo10, { RALPH_IDENTITY_WRAPPER: "/nonexistent/env-wrapper" });
expectResult("env override fails, no marker → fallback (falls through to default)", r, { wrapper: "", status: "fallback", source: "default-not-found" });

console.log("\n11) Env override failure WITH marker -> degraded");

const repo11 = createFakeRepo();
createTargetConfig(repo11, { enabled: true, wrapper: "/nonexistent/marker", role: "orchestrator" });
r = runResolve(repo11, { RALPH_IDENTITY_WRAPPER: "/nonexistent/env" });
expectResult("marker present, both fail → degraded (marker takes precedence)", r, { wrapper: "", status: "degraded", source: "marker-not-found" });

console.log("\n12) Default identity.sh failure with no marker -> fallback");

const repo12 = createFakeRepo();
mkdirSync(join(repo12, ".agents", "ralph"), { recursive: true });
writeFileSync(join(repo12, ".agents", "ralph", "identity.sh"), "# broken\n", { mode: 0o644 });
r = runResolve(repo12);
expectResult("default identity.sh not executable, no marker → fallback", r, { wrapper: "", status: "fallback", source: "default-not-executable" });

console.log("\n13) Default identity.sh failure WITH marker -> degraded");

const repo13 = createFakeRepo();
mkdirSync(join(repo13, ".agents", "ralph"), { recursive: true });
writeFileSync(join(repo13, ".agents", "ralph", "identity.sh"), "# broken\n", { mode: 0o644 });
createTargetConfig(repo13, { enabled: true, wrapper: "/nonexistent", role: "orchestrator" });
r = runResolve(repo13);
expectResult("marker present, default fails → degraded (marker takes precedence)", r, { wrapper: "", status: "degraded", source: "marker-not-found" });

console.log(`\nidentity-resolution: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
