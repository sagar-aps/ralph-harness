# Label protocol (canonical)

This is the **single source of truth** for the label set shared by the Manager role
and the orchestrator. Both roles reference this file; neither restates the
semantics below. If you change a label's meaning, change it here — nowhere else.

The labels are the asynchronous channel between the three parties (owner, Manager,
builder). GitHub issues/PRs carry them; closed issues keep the full audit trail
forever. Urgency travels through labels, not through loop speed.

| Label | Set by | Meaning |
|---|---|---|
| `now` | Manager / owner | Priority bucket — the orchestrator pulls work from here. |
| `later` | Manager / owner | Deferred priority bucket — not picked up. |
| `bug` | anyone | Nature: a defect against intended behavior. |
| `security` | anyone | Nature: a security-relevant issue; handle before feature work. |
| `decision-needed` | Manager | Needs a product/design decision before it can be specced; the orchestrator must not pick it up. |
| `spec:draft` | owner / Manager | An idea under Manager refinement; **the orchestrator must not pick it up.** |
| `spec:ready` | Manager | Acceptance section present and judged implementable. **The orchestrator takes only `now` + `spec:ready`.** Approval-requiring work never gets `spec:ready` until the approval has happened. |
| `blocked:owner` | Manager | Needs an owner action (a one-liner, a credential, a decision). The Manager pings the owner with the exact command/question. |
| `blocked:manager` | orchestrator | The orchestrator hit an arbitration question (often a blocker a builder surfaced that it cannot break): it posts the question + evidence as a comment, applies this label, parks the task, and moves on. **The orchestrator never removes this label** — only the Manager unblocks, by answering on the thread and removing it. |
| `verify:pending` | Manager | Merged, awaiting deploy-time acceptance. The Manager clears it after verifying deployed reality. |
| `recommendation` | Manager | A suggested change/improvement awaiting owner or Manager triage (not yet `now`/`later`). |

## Invariants both roles must honor

- The orchestrator's eligible set is exactly `now` AND `spec:ready`. It never touches
  `spec:draft`, `blocked:owner`, `blocked:manager`, or `decision-needed`.
- `blocked:manager` is orchestrator-applied, Manager-cleared. Never the reverse.
- The Manager owns `spec:ready` and every `## Acceptance` section — the orchestrator
  neither writes acceptance nor promotes `spec:draft` → `spec:ready`.
- Every state change is recorded as a comment on the issue/PR, not just a label flip.
