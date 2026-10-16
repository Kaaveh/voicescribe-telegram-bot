# Implementation Plan — 001 Voice Transcription

**Input:** `spec.md` · **Constitution check:** passes v1.0.1 with one temporary deviation (see §8, §9)
**Target:** the deployer's own Cloudflare account, free plan
**Operating model:** all Cloudflare commands are **agent-executed via `wrangler`** (Constitution art. VIII)

## 1. Technical context

| Aspect | Choice |
|---|---|
| Language | TypeScript (strict), ES2022 modules |
| HTTP framework | Hono (producer Worker) |
| Runtime | Cloudflare Workers, free plan (Paid $5/mo is the documented fallback if the ~10 ms CPU cap ever bites — unlikely, pipeline is `await fetch`-bound) |
| Async | Cloudflare Queues (`voicescribe-jobs` + DLQ `voicescribe-dlq`), `max_batch_size: 1`, `max_retries: 3` |
| Storage | KV namespace `voicescribe` (audio + transcripts, 30-day TTL per key; R2 needs a card on file, KV doesn't), D1 database `voicescribe` (jobs + dedup) |
| Pipeline | Gemini single-stage (AI Studio free tier), model set by `GEMINI_MODEL` (no bake-off — PRD §13 decision 12). Scribe→LLM and Workers AI are parked but stay possible behind the same interface |
| Testing | Vitest + `@cloudflare/vitest-pool-workers` (integration), pure-function unit tests for `src/core/` |
| Config | `wrangler.jsonc` (committed) + `wrangler secret` (never committed) |

## 2. Pipeline design

Every pipeline implements one interface (`contracts/asr-provider.interface.ts`)
returning `{ raw, clean }` so guards (FR-026/027) and persistence (FR-023) are
pipeline-agnostic:

- **Single-stage (v1):** one Gemini call with audio + versioned prompt
  `prompts/transcribe-fa.v1.md`, returning structured JSON
  `{ verbatim, formatted }`. `verbatim` is persisted as raw, `formatted` as
  clean — the length guard still has a real baseline.
- **Two-stage (parked):** Scribe (`language_code: fa`) → raw; Gemini Flash
  with `prompts/normalize-fa.v1.md` → clean. Un-parked only if no Gemini model
  passes AC-002 on the live bot (research.md).

Model fallback: when the primary `GEMINI_MODEL` still returns 503/429 after
FR-028's retries, the adapter tries `GEMINI_FALLBACK_MODEL` once before
throwing (research.md §Findings). Both IDs are recorded in the job's
`asr_provider` column.

Validation (`src/core/validate.ts`, pure): length guard with config bounds,
script guard (U+064A/U+0643), repeated-n-gram hallucination detector. On
failure: deliver raw + Persian "⚠️ raw output" marker (FR-025).

## 3. Producer flow (webhook Worker)

1. Constant-time check of `X-Telegram-Bot-Api-Secret-Token` → else 401 (FR-003).
2. Authorize `message.from.id === env.OWNER_TELEGRAM_USER_ID` → else log + 200 silence (FR-001/005).
3. Command / non-voice handling (FR-012/013) — Persian copy (FR-035).
4. Dedup + enqueue per the race-free protocol in `data-model.md` §Dedup
   (`received` → enqueue → `queued`), satisfying FR-015/016.
5. Placeholder `sendMessage` (reply to voice); tolerate failure with null
   `placeholder_message_id` (FR-030).

## 4. Consumer flow (queue Worker)

Stage-resumable per FR-029: load job → skip stages whose artifact/status
already exists (KV audio, KV transcripts, `delivered`). Cross-job
transcript reuse by `file_unique_id`. Stages: download → KV put → transcribe →
normalize → validate → deliver (edit / sendDocument / new reply) → mark
`delivered`. Explicit timeouts + backoff ×3 on 5xx/429 (FR-028); thrown error
→ queue retry → DLQ after 3 (AC-010).

## 5. Cloudflare provisioning — agent-executed command record

Automated, idempotently, by `scripts/provision.sh` (the record below is what
it runs; the script also writes the D1 `database_id` and KV `id` into `wrangler.jsonc` and
rotates the webhook secrets on each run). Before any mutating command:
`wrangler whoami` must show the intended (deployer's) account. Its
`account_id` is supplied via the `CLOUDFLARE_ACCOUNT_ID` environment variable,
not committed to `wrangler.jsonc`, so forks need no config edits.

```sh
wrangler whoami                                   # verify account, capture account_id
wrangler queues create voicescribe-jobs
wrangler queues create voicescribe-dlq
wrangler kv namespace create voicescribe          # capture id → wrangler.jsonc; TTL set per key (FR-050)
wrangler d1 create voicescribe                    # capture database_id → wrangler.jsonc
wrangler d1 migrations apply voicescribe --remote # schema from data-model.md
wrangler secret put TELEGRAM_BOT_TOKEN            # value supplied by owner at runtime
wrangler secret put GEMINI_API_KEY                # value supplied by owner at runtime
wrangler secret put WEBHOOK_SECRET_TOKEN          # agent-generated, high entropy
wrangler secret put WEBHOOK_PATH_SEGMENT          # agent-generated, high entropy (FR-004)
wrangler secret put OWNER_TELEGRAM_USER_ID        # value supplied by owner at runtime (FR-007)
wrangler deploy
wrangler tail                                     # live logs during verification
```

Webhook registration (idempotent, re-runnable): `scripts/set-webhook.ts` calls
Telegram `setWebhook` with `url=https://<worker>.workers.dev/webhook/<WEBHOOK_PATH_SEGMENT>`,
`secret_token=<WEBHOOK_SECRET_TOKEN>`, `allowed_updates=["message"]`,
`drop_pending_updates=true`. Executed by the agent after every deploy that
changes the route.

### Agent credentials

- **Owner's machine:** `wrangler login` (OAuth) — Wrangler already installed.
- **Remote agent sessions:** owner creates a scoped API token
  (Workers Scripts: Edit · Queues: Edit · Workers KV Storage: Edit · D1: Edit · Account
  Settings: Read) and provides it as
  `CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID`, in the session
  environment. Never committed, never echoed into logs (Constitution art. VI).

## 6. Configuration

| Name | Kind | Value / source |
|---|---|---|
| `OWNER_TELEGRAM_USER_ID` | secret | owner's numeric ID. Not sensitive on its own, but kept out of committed config so the public repo carries no personal values and forks need no edits (FR-007) |
| `NUMERAL_STYLE` | var | `persian` (PRD §13 decision 2) |
| `LENGTH_GUARD_MIN` / `MAX` | var | `0.6` / `1.4`, tuned after AC-000 (FR-026) |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` | var | exact model IDs, `gemini-3.5-flash` / `gemini-3.5-flash-lite` (research.md §Findings); never an alias such as `gemini-flash-latest` |
| `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `WEBHOOK_SECRET_TOKEN`, `WEBHOOK_PATH_SEGMENT` | secret | `wrangler secret put` |
| Bindings | — | queue producer+consumer `voicescribe-jobs` (DLQ `voicescribe-dlq`), KV `AUDIO`, D1 `DB` |

## 7. Verify against live docs (Phase 2, T020)

- Cloudflare Queues consumer wall-clock limit on the free plan.
- Gemini structured-output (JSON mode) support with audio input on
  `GEMINI_MODEL` (one live call), its free-tier rate limits, and its
  deprecation schedule.

## 8. Temporary deviation: committed `secrets.env` (Art. VI)

Approved by the owner on 2026-10-15 so agent sessions can work unattended:
credentials live in a committed `secrets.env` at the repo root while the
repository is private. The agent loads it with `set -a; . ./secrets.env`,
never prints values, and pipes each one into `wrangler secret put`.

Exit criteria, all required **before the repository is made public**:
1. Rotate every value: delete the Gemini key in AI Studio, `/revoke` the bot
   token in BotFather, roll the Cloudflare API token, and regenerate
   `WEBHOOK_SECRET_TOKEN` + `WEBHOOK_PATH_SEGMENT` (then re-run
   `scripts/set-webhook.ts`).
2. Delete `secrets.env` and squash history to a single commit, force-pushed
   to every branch.
3. Remember that PR refs keep their commits permanently (any PR opened while
   `secrets.env` existed). Rotation in step 1 is what makes those copies
   harmless.

## 9. Constitution check

| Article | How this plan complies |
|---|---|
| I | Auth is producer step 2, before any queue/ASR path |
| II + VII | Guards in pure `src/core/validate.ts`; every FR listed in `tasks.md` traceability |
| III | FR-034 paths in consumer; DLQ handler still notifies user |
| IV | `src/core/` pure; Telegram/ASR/storage in `src/adapters/` behind interfaces |
| V | `prompts/*.v1.md` + golden suite (Phase 6) |
| VI | Secrets only via `wrangler secret`; webhook path segment is a secret. **Temporary deviation:** committed `secrets.env` (§8) |
| VIII | §5 above is the reproducible command record; account verified via `whoami` |
