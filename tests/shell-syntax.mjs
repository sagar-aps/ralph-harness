// Parse-checks every shell script with `bash -n`, using the SAME bash the loop runs
// under (`#!/usr/bin/env bash` -> first bash on PATH). On macOS that is Bash 3.2, so
// running `npm test` there catches 3.2-only parse failures like #21 (a lone apostrophe
// in a $(...) heredoc body) before they reach a real run. On a dev box (bash 5.x) it
// still catches gross syntax errors.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// All *.sh, plus the extensionless floor-guard shims (they have a bash shebang).
function shellScripts(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) shellScripts(p, acc);
    else if (name.endsWith(".sh")) acc.push(p);
    else if (path.basename(path.dirname(p)) === "floor-guard") {
      try { if (readFileSync(p, "utf8").startsWith("#!")) acc.push(p); } catch {}
    }
  }
  return acc;
}

const bashVer = (spawnSync("bash", ["--version"], { encoding: "utf8" }).stdout || "").split("\n")[0];
console.log(`shell-syntax: bash -n over all scripts  (${bashVer || "bash version unknown"})`);

let failures = 0;
for (const f of shellScripts(repoRoot).sort()) {
  const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
  const rel = path.relative(repoRoot, f);
  if (r.status === 0) { console.log(`  ✔ ${rel}`); }
  else { console.error(`  x FAIL ${rel}\n${(r.stderr || "").split("\n").map((l) => "      " + l).join("\n")}`); failures += 1; }
}

console.log(`\nshell-syntax: ${failures ? failures + " failed" : "all passed"}`);
process.exit(failures ? 1 : 0);
