# Feature Spec — 001 Voice Transcription

**Status:** Approved by owner (2026-10-15) · **Source:** `PRD-voicescribe-telegram-bot.md` v0.5
**Constitution:** `.specify/memory/constitution.md` v1.0.1

Single-tenant Telegram bot: the owner forwards (or records) a Persian voice
message; the bot returns a NotebookLM-quality Persian transcript in the same
chat, in under a minute, with zero other steps.

---

## 1. User scenarios

### US-1 — Forwarded voice message (primary)

1. Owner forwards a Persian voice message to the bot.
2. Within ~2 s the bot replies to it: `⏳ در حال رونویسی…`
3. Within 90 s that placeholder is edited in place into the finished transcript.
4. Transcripts over 4000 chars arrive as a `.md` document instead (placeholder
   edited to a short Persian "transcript attached ⬇" note).

### US-2 — Directly recorded voice message

Recording a voice note in the bot chat behaves identically to US-1 — same
`message.voice` payload.

### US-3 — Non-voice input from the owner

Text, photo, document, audio, or video_note from the owner gets a short,
friendly Persian "voice messages only in v1" reply. `/start` and `/help`
return a one-paragraph Persian description of the bot.

### US-4 — Anyone else

Any update from a non-owner sender produces **no response of any kind**. The
attempt is logged. This includes non-voice inputs — silence takes precedence
over US-3.

### Edge cases

| Case | Expected behavior |
|---|---|
| Voice file > 20 MB (Telegram `getFile` ceiling) | Persian error message explaining the limit; no infinite retry |
| Telegram redelivers the same `update_id` | Exactly one transcript, one ASR charge |
| Queue redelivers after a mid-pipeline crash | Consumer resumes from last completed stage; no duplicate ASR charge, no double edit |
| Same voice note forwarded twice (same `file_unique_id`) | Transcript reused; no new ASR call |
| ASR/LLM provider down (5xx on all retries) | Persian failure message with correlation ID; job lands in DLQ |
| Placeholder `sendMessage` fails | Job still enqueued; transcript delivered as a new reply instead of an edit |
| Voice message carries a caption | Caption ignored |
| Normalization output fails validation | Raw ASR text delivered with a Persian "⚠️ raw output" marker |

## 2. Functional requirements

Stable IDs, mirrored from PRD §7 — the PRD is the narrative authority; this
list is the test contract.

### Access control

- **FR-001** Process updates only when `message.from.id` equals `OWNER_TELEGRAM_USER_ID`.
- **FR-002** Authorization by numeric user ID only, never username.
- **FR-003** Webhook registered with a `secret_token`; reject 401 unless
  `X-Telegram-Bot-Api-Secret-Token` matches (constant-time comparison).
- **FR-004** Webhook path contains a high-entropy random segment.
- **FR-005** Unauthorized senders receive no reply of any kind; attempt logged.
- **FR-006** Bot privacy mode enabled via BotFather; never added to groups.
- **FR-007** `OWNER_TELEGRAM_USER_ID` from environment, never hardcoded.

### Ingestion

- **FR-010** Accept `message.voice` — forwarded and directly recorded.
- **FR-011** Forwarded voice handled identically regardless of `forward_origin` privacy.
- **FR-012** Non-voice inputs **from the owner** get a friendly Persian reply; FR-005 takes precedence for everyone else.
- **FR-013** `/start` and `/help` return a one-paragraph Persian description.
- **FR-014** Files over 20 MB produce an explanatory Persian message, not a crash.
- **FR-015** Duplicate `update_id` values are ignored.
- **FR-016** Dedup must not drop a message whose enqueue failed: a failure
  between dedup check and enqueue leaves the update reprocessable on
  Telegram's retry. (Protocol: `data-model.md` §Dedup.)
- **FR-017** Voice-message captions are ignored.

### Transcription pipeline

- **FR-020** Audio persisted to KV (keyed by `file_unique_id`) before the ASR call.
- **FR-021** Existing KV entry for a `file_unique_id` → skip download.
- **FR-022** ASR language pinned to `fa`; no autodetection in v1.
- **FR-023** Raw ASR output persisted alongside cleaned output.
- **FR-024** Normalization prompt is a constrained, versioned file
  (`prompts/*.v1.md`): reformat only — never add, remove, summarize,
  translate, or answer.
- **FR-025** Normalization output validated before delivery; on validation
  failure deliver raw text with a Persian "⚠️ raw output" marker.
- **FR-026** Length guard: clean output within 60–140% of raw character count.
  Bounds are config values (`LENGTH_GUARD_MIN`/`MAX`), tunable against the
  golden set.
- **FR-027** Script guard: reject output containing U+064A (`ي`) or U+0643 (`ك`).
- **FR-028** All ASR/LLM calls have explicit timeouts; retry with exponential
  backoff on 5xx/429, max 3 attempts.
- **FR-029** Consumer is stage-resumable (skip download / ASR / normalize /
  delivery when the corresponding artifact or status already exists), and
  reuses transcripts across jobs sharing a `file_unique_id`.

### Delivery

- **FR-030** Placeholder sent as a reply to the voice message, targeting < 2 s
  (target, not hard gate). If `sendMessage` fails, enqueue anyway with null
  `placeholder_message_id`; consumer delivers as a new reply.
- **FR-031** Transcript replaces the placeholder via `editMessageText`.
- **FR-032** Transcripts > 4000 chars delivered as a `.md` document (reply to
  the voice message); placeholder edited to a short pointer note.
- **FR-033** Plain text by default; MarkdownV2 only with full escaping.
- **FR-034** Every terminal failure yields a human-readable Persian message
  with a correlation ID. Silent failure is a defect.
- **FR-035** All user-facing copy in Persian; correlation IDs Latin/ASCII.

### Observability

- **FR-040** Per-job structured log: `update_id`, `file_unique_id`, duration,
  ASR latency, LLM latency, raw/clean char counts, outcome, correlation ID.
- **FR-041** Transcript content never written to logs.
- **FR-042** DLQ entries inspectable and manually replayable.

### Retention & privacy

- **FR-050** All stored audio and transcripts deleted after 30 days via a
  per-key KV TTL. (KV replaces the PRD's R2 on 2026-10-16: R2 requires a
  payment method on the account, KV does not.)
- **FR-051** D1 rows are metadata-only and may be retained indefinitely.

## 3. Acceptance criteria

- **AC-000 — Provider bake-off.** Dropped (PRD §13 decision 12). The pipeline
  is Gemini single-stage; `GEMINI_MODEL` is set by configuration
  (`research.md`).
- **AC-001 — Happy path.** 3-min Persian voice message → placeholder ≤ 2 s →
  clean transcript ≤ 90 s.
- **AC-002 — Quality gate.** ≥ 8 of the first 10 real transcripts from the
  live bot judged by the owner "equal or better than NotebookLM."
  (Deliberately subjective — this is the product requirement; WER is a
  proxy.) If it fails: iterate the prompt or switch `GEMINI_MODEL`.
- **AC-003 — Orthography.** Zero U+064A/U+0643 in any transcript; ZWNJ correct
  in a 20-sample spot-check.
- **AC-004 — No summarization.** 10-min message → delivered chars within
  60–140% of raw; no sentence whose meaning is absent from the raw transcript.
- **AC-005 — Access control.** Non-owner voice message → no reply, no ASR
  call, no spend; attempt logged.
- **AC-006 — Forged webhook.** POST without valid secret header → 401, nothing
  enqueued.
- **AC-007 — Oversized file.** > 20 MB → clear Persian explanation; no
  infinite retry.
- **AC-008 — Idempotency.** Telegram redelivery of an `update_id` **or** queue
  redelivery after a crash → exactly one transcript, one ASR charge.
- **AC-009 — Long transcript.** > 4000 chars → `.md` document + edited
  placeholder pointer.
- **AC-010 — Provider outage.** 503 × 3 attempts → Persian failure message
  with correlation ID; job in DLQ.

## 4. Non-goals (v1)

Multi-user access · summaries/interpretation · diarization · timestamps ·
non-voice media · translation · web UI/search/export · streaming. See PRD §12
for the v2 parking lot.

## 5. Dependencies & assumptions

- Owner assets: Telegram bot (BotFather, privacy mode on), Gemini API key
  (Google AI Studio free tier — a Google AI Pro subscription does **not**
  include API access).
- Cloudflare account: the deployer's own, free plan. All provisioning is
  agent-executed via `wrangler` (Constitution art. VIII).
- Accepted tradeoffs (PRD §13): free-tier Gemini data usage; NotebookLM-as-
  reference inherits its errors; 30-day retention window.
