# Which setup? (start here)

The harness looks like it has a lot of options. It doesn't — it has **one small choice**.
Everything else is the same underneath.

## The mental model: workers + a driving layer

**The workers never change.** In every setup, the actual code work is done by the same two
harness roles:

- **Builder** — sees the code, writes the code, reports up to whoever dispatched it (blockers,
  and anything it noticed wrong). It never files PRs and never talks to a Manager.
- **Reviewer** — read-only `PASS` / `FAIL` on the builder's diff.

**You choose the driving layer** — who points the workers at tasks and who signs off:

| | **Unmanaged** (you drive) | **Managed** (agents drive) |
|---|---|---|
| Who drives | **You**, in the pilot seat, running `ralph …` | An **Orchestrator** agent (autonomous, hourly) under a **Manager** agent |
| The gate | You review the result and integrate | The **Manager** (frontier, in the repo): acceptance + merge + prod deploy |
| Work source | PRD / task files (`.agents/tasks/`, `--plan`, `--task`) | GitHub issues + labels + `## Acceptance` |
| Labels / tickets | not needed | required ([label protocol](../.agents/ralph/references/LABELS.md)) |
| Deploy | you | Orchestrator → dev, Manager → prod |
| Extra roles to boot | none | `/manager` (in repo) + Orchestrator (above repo) |
| Best for | simpler or one-off projects | complex, ongoing projects |

**Dispatch granularity is orthogonal** — it applies to both setups and is just "how many tasks
per run":

- `ralph review <task>` — **single**: one task through the builder→check→reviewer loop.
- `ralph batch` — **batch**: many tasks in sequence on one shared worktree.

Managed mode doesn't replace these — the Orchestrator *runs them under the hood* on its loop.

## Picking one

- **Just want work done on a simpler repo?** Use **unmanaged**. Run `ralph review` / `ralph
  batch` yourself, read the result, integrate. No Manager, no Orchestrator, no labels. This is
  the original ralph and it is complete on its own — see the rest of
  [agent-operator.md](agent-operator.md).
- **Steering a complex, long-lived project and want it to run without you in the loop?** Use
  **managed**. Boot `/manager` in the repo and the Orchestrator above it; everything flows
  through GitHub tickets, acceptance, and the label protocol. See
  [architecture.md](architecture.md) for the full role picture and
  [the managed-mode how-to](agent-operator.md#managed-mode) for the boot steps.

You can start unmanaged and add managed mode later — the workers and the harness commands are
identical, so nothing you set up is wasted.

## Why this is the whole story

There is no third mode and no hidden flag. "Managed" is not a switch on the builder — the
builder is the same either way. It is simply *whether an Orchestrator + Manager sit on top of
the loop instead of you*. That single distinction is the entire surface area.
