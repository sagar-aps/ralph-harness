# Memorix — repo primer for builders (orientation map; read first)

**CLAUDE.md is the rulebook — read it.** This primer does not restate its rules; it only
maps where things live and adds the guidance the loop needs.

Memorix is an AI memory/document assistant for small businesses: WhatsApp Quick Capture,
document processing with PII anonymization, and RAG chat. Stack: **Next.js 14** (`web/`)
on Vercel + **AWS Lambda via SAM** (`infrastructure/`) + **MongoDB Atlas** + **Cognito**.

## Layout (what lives where)
- `web/`                 Next.js app. TS/TSX. e2e specs in `web/e2e/` (Playwright).
- `web/src/lib/config.ts`  Frontend runtime config — API endpoint + feature flags.
                        **Source of truth** for the prod API gateway id (read it; never hardcode ids).
- `infrastructure/`     AWS SAM: `template.yaml`, `lambda/` (Python), `deploy.sh`.
- `infrastructure/lambda/prompts/`  Runtime AI prompts (parsing, extraction). Edit here, not `.claude/`.
- `docs/STATUS.md`      The ONLY status file. Update its table when feature state changes.
- `docs/BACKLOG.md`     Backlog pointer — the real backlog is GitHub Issues (`now`/`later`).
- `tools/wt.sh`         The only sanctioned worktree helper.

## Build / test commands (run from the repo root)
- `cd web && npm run type-check`            — `tsc --noEmit`; fast gate, run before claiming done
- `cd web && npm run build`                 — full production build
- `cd web && npx playwright test --grep @smoke`  — e2e smoke
- `cd infrastructure && pytest`             — backend unit tests

## Environments (orientation — details in docs/infrastructure/ENVIRONMENTS.md)
- Prod stack: `memorix-api-v50` (API Gateway `:live` aliases). Dev stack: `memorix-api-dev`.
- ⚠ Dev is **not** a clean sandbox: only the MongoDB database is isolated; the S3 bucket
  and Cognito user pool are SHARED with prod. Read ENVIRONMENTS.md before assuming otherwise.

## How the builder is expected to work (loop guidance)
- Read before editing; reuse existing patterns rather than duplicating.
- Make the **smallest correct change** that satisfies the task's Acceptance.
- Prefer reading the deployed frontend's own defaults (`web/src/lib/config.ts`) over
  making live AWS calls to discover endpoints/ids.
- Don't weaken, skip, or delete tests to make checks pass.
