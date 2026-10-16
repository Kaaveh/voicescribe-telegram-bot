# Tasks — 001 Voice Transcription

Executor legend: **[agent]** = AI agent (includes all `wrangler` commands,
Constitution art. VIII) · **[owner]** = the bot owner, listed exceptions only ·
**[P]** = parallelizable within its phase. Every phase ends with a gate; do
not start the next phase before the gate passes.

## Phase 0 — Constitution & spec

- [x] **T001** [agent] Constitution → `.specify/memory/constitution.md`
- [x] **T002** [agent] Feature spec → `spec.md` (from PRD v0.3)
- [x] **T003** [owner] Sign off on constitution + spec (2026-10-15)
      **Gate 0:** owner sign-off.

## Phase 1 — Provider setup (bake-off dropped, PRD §13 decision 12)

- [x] **T010** [owner] Create Gemini API key in Google AI Studio (free tier;
      AI Pro subscription does not include API access)
- [x] **T013** [agent] First drafts of `prompts/transcribe-fa.v1.md` and
      `prompts/normalize-fa.v1.md`
- [x] **T017** [owner] Make `GEMINI_API_KEY` available to agent sessions
      (done via committed `secrets.env` — temporary deviation, plan.md §8)
      **Gate 1:** key available to agent sessions.

## Phase 2 — Plan, contracts, data model

- [x] **T021** [agent] Contracts drafted (`contracts/`)
- [x] **T022** [agent] Data model + dedup protocol (`data-model.md`)
- [~] **T020** [agent] Verify against live docs (plan.md §7): Gemini model
      confirmed live, incl. the Files API path (research.md §Findings);
      `kv namespace create` confirmed from wrangler 4.151 `--help` (R2 dropped
      2026-10-16: needs a card on file). **Open:** Queues free-plan wall-clock limit
      (Cloudflare docs unreachable from the agent environment)
- [x] **T023** [agent] Pipeline interface implemented in
      `src/adapters/gemini.ts`; D1 migration `migrations/0001_jobs.sql`
      (adds `file_id`, `file_size` — data-model.md)
      **Gate 2:** passed except the open T020 item.

> Code for Phases 3–5 was written and tested locally ahead of deployment
> (owner request, 2026-10-15). Items that need the live Cloudflare account
> stay open until `scripts/provision.sh` runs.

## Phase 3 — Walking skeleton (deploys to Cloudflare)

- [x] **T030** [agent] Scaffold: `package.json`, `tsconfig.json`, Hono, Vitest
      + `@cloudflare/vitest-plugin`, `wrangler.jsonc`, `.npmrc`
- [x] **T031** [agent] `wrangler whoami` → confirm it is the owner's
      Cloudflare account (`account_id` via `CLOUDFLARE_ACCOUNT_ID`, not committed)
- [x] **T032** [agent] Provision queues, KV namespace, D1 + migrations
      via `scripts/provision.sh` (2026-10-16)
- [x] **T033** [owner] BotFather: bot created, token + owner ID provided,
      privacy mode enabled (FR-006, confirmed 2026-10-16)
- [x] **T034** [agent] Secrets via `wrangler secret bulk`
- [x] **T035** [agent] Producer (`src/producer.ts`)
- [x] **T036** [agent] Consumer — superseded by the full consumer (T045)
- [x] **T037** [agent] `wrangler deploy` + `scripts/set-webhook.ts`
- [x] **T038** [agent] AC-005/AC-006 tests pass; live smoke test passed
      (wrong paths 404, owner voice note delivered)
      **Gate 3:** passed 2026-10-16.

## Phase 4 — Full pipeline

- [x] **T040** [agent] Telegram adapter (`src/adapters/telegram.ts`)
- [x] **T041** [agent] [P] Storage adapter (`src/adapters/storage.ts`)
- [x] **T042** [agent] Gemini single-stage adapter (`src/adapters/gemini.ts`):
      Files API upload, versioned prompt, timeouts/backoff, fallback model
- [x] **T043** [agent] [P] `src/core/validate.ts`
- [x] **T044** [agent] [P] `src/core/format.ts`
- [x] **T045** [agent] Consumer stages + delivery (`src/consumer.ts`)
- [~] **T046** [agent] AC-003/AC-004 guards tested. AC-001 live: a 2:06 voice
      note got its placeholder in 0.5 s and its transcript about 30 s later.
      **Open:** AC-002, 1 of 10 owner-judged transcripts so far (approved)
      **Gate 4:** pending AC-002.

## Phase 5 — Resilience

- [x] **T050** [agent] Terminal-failure UX + DLQ landing (AC-010)
- [x] **T051** [agent] [P] Oversized-file path test (AC-007)
- [x] **T052** [agent] [P] Long-transcript path test (AC-009)
- [x] **T053** [agent] Stage-resume + cross-job reuse + redelivery (AC-008)
- [x] **T054** [agent] Replay via the owner's `/retry` command (FR-042);
      failed jobs are listed with
      `wrangler d1 execute voicescribe --remote --command "SELECT id, error_code, created_at FROM jobs WHERE status = 'failed'"`
      **Gate 5:** passed in tests; re-check live.

## Phase 6 — Golden suite & observability

- [ ] **T060** [agent] Golden-transcript regression suite from owner-approved
      live transcripts (`tests/golden/`, fixtures kept out of git if private);
      wire as the prompt-change gate (Constitution art. V)
- [x] **T061** [agent] [P] Structured job logs (FR-040) without content
      (FR-041) — verified via `wrangler tail` on the live bot (2026-10-16)
- [x] **T062** [agent] FR→test traceability matrix below
      **Gate 6 (ship):** every FR maps to a passing test or documented manual
      check (Constitution art. VII).

`[~]` = partly done; the open part is named.

## FR → test traceability

Unit: `tests/unit/core.test.ts` · Producer: `tests/integration/producer.test.ts`
· Consumer: `tests/integration/consumer.test.ts`.

| FR | Test | Status |
|---|---|---|
| FR-001, FR-002 | unit "classify … rejects other users, even with the owner username" | ✅ |
| FR-003 | unit "secretsEqual"; producer "AC-006" | ✅ |
| FR-004 | producer "FR-004: unknown path segment is a 404" | ✅ |
| FR-005 | producer "AC-005" | ✅ |
| FR-006 | manual: BotFather privacy mode (T033) | ✅ owner |
| FR-007 | owner ID read from the `OWNER_TELEGRAM_USER_ID` secret; no literal in `src/` | ✅ (review) |
| FR-010, FR-011, FR-017 | unit "accepts owner voice, forwarded or not, ignoring captions" | ✅ |
| FR-012, FR-013 | producer "FR-013/012"; unit "routes /start…" | ✅ |
| FR-014 | consumer "AC-007" (both) | ✅ |
| FR-015 | producer "AC-008 / FR-015" | ✅ |
| FR-016 | producer "FR-016" | ✅ |
| FR-020, FR-021 | consumer "AC-001", "AC-008: … resumes", "FR-029", "FR-020: a first run …" | ✅ |
| FR-022 | Persian pinned in `prompts/transcribe-fa.v1.md` (Gemini has no language parameter) | ✅ (review) |
| FR-023 | consumer "AC-001" (raw + clean persisted) | ✅ |
| FR-024 | consumer "AC-001" (versioned prompt sent) | ✅ |
| FR-025 | consumer "FR-025"; unit "falls back to marked … raw text" | ✅ |
| FR-026 | unit "catches silent summarization" | ✅ |
| FR-027 | unit "catches Arabic ي/ك" | ✅ |
| FR-028 | consumer "AC-010" (3 attempts + fallback) | ✅ |
| FR-029 | consumer "AC-008 …", "FR-029" | ✅ |
| FR-030 | producer "FR-030"; consumer "FR-030" | ✅ |
| FR-031 | consumer "AC-001", "falls back to a reply…", "message is not modified" | ✅ |
| FR-032 | consumer "AC-009"; unit "switches to a document" | ✅ |
| FR-033 | plain text only — no `parse_mode` anywhere in `src/` | ✅ (review) |
| FR-034 | consumer "AC-007", "AC-010", "never leaves the placeholder…" | ✅ |
| FR-035 | all copy in `src/core/messages.ts` | ✅ (review) |
| FR-040, FR-041 | consumer "AC-001" (metrics logged, no content) | ✅ · ✅ `wrangler tail` |
| FR-042 | producer "FR-042" (both) | ✅ |
| FR-050 | consumer "FR-050: every stored key expires 30 days …" | ✅ |
| FR-051 | D1 schema has no content columns | ✅ (review) |
