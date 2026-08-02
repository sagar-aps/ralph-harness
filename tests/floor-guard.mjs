// Mutation tests for the orchestrator floor guard (.agents/ralph/floor-guard/).
// Plant each forbidden op → expect a floor refusal (exit 93) and the real binary
// NOT invoked. Confirm allowed ops pass through to the (stubbed) real binary.
// Hermetic: the "real" gh/git are local stubs, so nothing hits the network.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guardDir = join(here, "..", ".agents", "ralph", "floor-guard");
const work = mkdtempSync(join(tmpdir(), "floor-guard-"));

// Stub "real" binaries: echo a marker so we can detect pass-through; the git
// stub answers rev-parse with $FAKE_BRANCH so the bare-push path is testable.
const ghStub = join(work, "gh");
writeFileSync(ghStub, `#!/usr/bin/env bash\necho "REAL_GH $*"\n`);
chmodSync(ghStub, 0o755);
const gitStub = join(work, "git");
writeFileSync(
  gitStub,
  `#!/usr/bin/env bash\nif [ "$1 $2 $3" = "rev-parse --abbrev-ref HEAD" ]; then echo "\${FAKE_BRANCH:-feature-x}"; else echo "REAL_GIT $*"; fi\n`,
);
chmodSync(gitStub, 0o755);

let pass = 0, fail = 0;
const REFUSE = 93;

function run(bin, args, extraEnv = {}) {
  return spawnSync(join(guardDir, bin), args, {
    encoding: "utf8",
    env: {
      ...process.env,
      RALPH_REAL_GH: ghStub,
      RALPH_REAL_GIT: gitStub,
      RALPH_DEFAULT_BRANCH: "main",
      ...extraEnv,
    },
  });
}

function expectRefused(label, bin, args, env) {
  const r = run(bin, args, env);
  const ok = r.status === REFUSE && !/REAL_(GH|GIT)/.test(r.stdout || "");
  console.log(`  ${ok ? "✔" : "✗"} REFUSED: ${label}`);
  if (ok) pass++; else { fail++; console.log(`      status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`); }
}

function expectPass(label, bin, args, env) {
  const r = run(bin, args, env);
  const ok = r.status === 0 && /REAL_(GH|GIT)/.test(r.stdout || "");
  console.log(`  ${ok ? "✔" : "✗"} PASS-THROUGH: ${label}`);
  if (ok) pass++; else { fail++; console.log(`      status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`); }
}

console.log("floor-guard mutation tests");
console.log("1) gh: merge and approve are refused; reject/comment/create pass through");
expectRefused("gh pr merge 5", "gh", ["pr", "merge", "5"]);
expectRefused("gh pr merge --squash 5", "gh", ["pr", "merge", "--squash", "5"]);
expectRefused("gh pr review --approve 5", "gh", ["pr", "review", "--approve", "5"]);
expectRefused("gh pr review -a 5", "gh", ["pr", "review", "-a", "5"]);
expectPass("gh pr review --request-changes 5", "gh", ["pr", "review", "--request-changes", "-b", "no", "5"]);
expectPass("gh pr create ...", "gh", ["pr", "create", "--title", "x", "--body", "y"]);
expectPass("gh pr comment ...", "gh", ["pr", "comment", "5", "-b", "hi"]);

console.log("2) git: pushing the default branch is refused; run branches pass through");
expectRefused("git push origin main", "git", ["push", "origin", "main"]);
expectRefused("git push origin HEAD:main", "git", ["push", "origin", "HEAD:main"]);
expectRefused("git push origin main:main", "git", ["push", "origin", "main:main"]);
expectRefused("git push --force origin main", "git", ["push", "--force", "origin", "main"]);
expectRefused("git push (current branch IS main)", "git", ["push"], { FAKE_BRANCH: "main" });
expectPass("git push -u origin feat/x", "git", ["push", "-u", "origin", "feat/x"]);
expectPass("git push origin HEAD:feat/x", "git", ["push", "origin", "HEAD:feat/x"]);
expectPass("git push (current branch is a run branch)", "git", ["push"], { FAKE_BRANCH: "feat/x" });
expectPass("git status (non-push)", "git", ["status", "-s"]);

console.log(`\nfloor-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
