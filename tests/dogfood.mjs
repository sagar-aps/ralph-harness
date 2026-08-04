// Regression gate for #35 (self-host preflight fork bomb). Two fast, SAFE assertions
// that the guards are in place — this never reproduces the bomb, it proves it can't
// happen. Must NOT be listed in `test:dogfood` (it invokes check.sh, which would
// re-invoke test:dogfood -> recurse).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (c, m) => { console.log((c ? "  ✔ " : "  x FAIL: ") + m); if (!c) failures += 1; };

console.log("dogfood/#35: re-entrancy guard + dogfood check");

// 1) preflight.sh must SKIP when nested (RALPH_IN_PREFLIGHT=1), without running the
//    configured check — this is what breaks the preflight -> npm test -> ralph recursion.
{
  const target = mkdtempSync(path.join(tmpdir(), "ralph-df-"));
  writeFileSync(
    path.join(target, "ralph.target.json"),
    JSON.stringify({ preflight: { enabled: true, check: "echo SHOULD_NOT_RUN; exit 1" } }),
  );
  const r = spawnSync(
    "bash",
    [path.join(repoRoot, ".agents/ralph/preflight.sh"), target, path.join(target, "pf.md")],
    { encoding: "utf-8", env: { ...process.env, RALPH_IN_PREFLIGHT: "1" } },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(r.status === 0, "nested preflight exits 0 (skipped, not failed)");
  check(/re-entrancy guard/.test(out), "reports the re-entrancy guard reason");
  check(!/SHOULD_NOT_RUN/.test(out), "the configured check did NOT run when nested (recursion cut)");
}

// 2) The self-host check.sh runs the NON-recursive dogfood subset when nested, and does
//    not run the ralph-loop-spawning suites.
{
  const r = spawnSync("bash", [path.join(repoRoot, "scripts/check.sh")], {
    encoding: "utf-8",
    cwd: repoRoot,
    env: { ...process.env, RALPH_IN_PREFLIGHT: "1" },
  });
  const out = `${r.stdout}${r.stderr}`;
  check(r.status === 0, "nested self-host check passes");
  check(/dogfood mode/.test(out), "runs in dogfood mode when nested");
  check(/shell-syntax: all passed/.test(out), "the non-recursive subset actually ran");
  check(!/Agent loop smoke tests/.test(out), "did NOT run the recursive loop suites (no fork-bomb path)");
}

// 3) Dogfood is HARNESS-ONLY: a DIFFERENT repo that reuses this exact check.sh must
//    NOT enter dogfood mode, even nested — it runs its own full check. (Guards against
//    the harness breaking other repos by mistake.)
{
  const fake = mkdtempSync(path.join(tmpdir(), "ralph-notharness-"));
  mkdirSync(path.join(fake, "scripts"));
  copyFileSync(path.join(repoRoot, "scripts/check.sh"), path.join(fake, "scripts/check.sh"));
  writeFileSync(
    path.join(fake, "package.json"),
    JSON.stringify({ name: "some-other-repo", scripts: { test: "echo FULL_CHECK_RAN" } }),
  );
  const r = spawnSync("bash", [path.join(fake, "scripts", "check.sh")], {
    encoding: "utf-8",
    cwd: fake,
    env: { ...process.env, RALPH_IN_PREFLIGHT: "1" },
  });
  const out = `${r.stdout}${r.stderr}`;
  check(!/dogfood mode/.test(out), "a non-harness repo does NOT enter dogfood mode when nested");
  check(/FULL_CHECK_RAN/.test(out), "a non-harness repo runs its FULL check even when nested");
}

console.log(failures ? `\ndogfood/#35 regression FAILED (${failures})` : "\ndogfood/#35 regression passed.");
process.exit(failures ? 1 : 0);
