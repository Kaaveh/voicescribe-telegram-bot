# PRD — VoiceScribe: Personal Telegram Voice Transcription Bot

| | |
|---|---|
| **Status** | v0.5 — bake-off dropped, Gemini single-stage (2026-10-15); spec approved |
| **Owner** | Kaaveh |
| **Date** | 2026-08-07 |
| **Target platform** | Cloudflare Workers (TypeScript) |
| **Methodology** | Spec-Driven Development (GitHub Spec Kit conventions) |

---

## 1. Problem statement

Today, turning a Telegram voice message into readable text is a manual, five-step chore: play the message, download the `.ogg`, open NotebookLM, upload, wait, copy the transcript out. NotebookLM's output quality is the bar — clean, punctuated, properly-spelled Persian that reads like prose rather than a wall of ASR tokens — but the workflow around it is friction that discourages use.

**Goal:** forward a voice message to a bot, get a NotebookLM-quality Persian transcript back in the same chat, in under a minute, with zero other steps.

## 2. Non-goals (v1)

Explicitly out of scope. Listing these protects the spec from scope drift.

- Multi-user or public access. This is a single-tenant bot for one Telegram account.
- Summaries, bullet points, action items, or any interpretation of content.
- Speaker diarization / speaker labels.
- Timestamps.
- Audio files, video notes, forwarded videos, documents — voice messages only.
- Translation to English or any other language.
- A web UI, search over past transcripts, or an export/archive feature.
- Real-time / streaming transcription.

> Several of these (diarization, summaries, audio files) are natural v2 candidates and are parked in §12.

## 3. Users & primary scenario

**Single user.** One fixed Telegram account, identified by numeric `user_id`, hard-pinned in config.

**Primary scenario**

1. The owner receives a Persian voice message in some Telegram chat.
2. They forward it to their own bot.
3. Within ~2 seconds the bot replies `⏳ در حال رونویسی…` (transcribing).
4. Within ~30–60 s that same message is edited in place to contain the finished transcript.
5. If the transcript exceeds Telegram's message limit, it arrives as a `.md` file attachment instead.

**Secondary scenario** — recording directly into the bot chat (not forwarding) must work identically. It's the same `message.voice` payload.

## 4. Quality bar — what "NotebookLM-quality" actually means

This is the heart of the product and the requirement most likely to be under-specified. Raw ASR output is not the deliverable; a *readable Persian document* is.

The output MUST be:

| Property | Requirement |
|---|---|
| **Faithful** | Every substantive word the speaker said appears. Nothing invented, nothing summarized, nothing omitted. |
| **Punctuated** | Correct Persian punctuation: `،` `؛` `؟` `.` — not the ASCII equivalents. |
| **Paragraphed** | Broken at topic/breath boundaries, not one continuous block. |
| **Orthographically correct Persian** | Persian `ی`/`ک` (U+06CC/U+06A9), never Arabic `ي`/`ك` (U+064A/U+0643). Correct ZWNJ (نیم‌فاصله, U+200C) in compounds: `می‌روم` not `میروم` or `می روم`. |
| **De-disfluenced** | Filler words (`اِه`, `یعنی` used as filler, `خب` as filler, repeated false starts, stutters) removed — but *only* when they carry no meaning. |
| **Non-hallucinating** | No repeated-loop artifacts on silence, no invented sentences at the end. Whisper-family models are notorious for both. |
| **Numerals** | Consistent — Persian digits (`۱۲۳`) throughout. **Decided** (§13): Persian digits, config-overridable. |
| **Mixed-language safe** | English technical terms spoken inside Persian speech stay in Latin script (`Kubernetes`, not `کوبرنتیز`). |

**This quality bar is not achievable from ASR alone.** It requires a two-stage pipeline: a strong Persian ASR model, then an LLM normalization pass. §6 covers the design; §7.3 covers why the normalization prompt is the riskiest part of the system.

## 5. Technology decisions

### 5.1 Runtime: TypeScript on Cloudflare Workers (decided)

Go was the initial preference, and it's worth recording why it lost, because that reasoning should not have to be rediscovered later.

Cloudflare Workers runs V8 isolates, not containers. Go reaches Workers only by compiling to WASM via TinyGo, which brings a reduced stdlib, awkward interop with the JS `fetch`/streams world, larger bundles, and poor debugging. For a service that is *almost entirely* HTTP calls and JSON — exactly what Workers' native runtime is best at — the WASM detour buys nothing and costs a lot.

**Decision: TypeScript + Hono on Workers.** Go remains the right choice if this ever moves to Cloudflare Containers, Fly.io, or Cloud Run; that migration path is noted in §12.

### 5.2 Cloudflare primitives used

| Primitive | Role |
|---|---|
| **Workers** | Webhook endpoint (producer) + queue consumer |
| **Queues** | Decouples the 200-OK webhook ack from the slow transcription job; gives retries and a DLQ for free |
| **R2** | Stores the downloaded `.ogg` so a retry doesn't re-download from Telegram; optional short TTL |
| **D1** | Job records + `update_id` dedup for webhook idempotency. **D1, not KV** — KV is eventually consistent, which makes `update_id` dedup racy in exactly the window where Telegram retries. |
| **Secrets Store** | `TELEGRAM_BOT_TOKEN`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `WEBHOOK_SECRET_TOKEN` |

Queues is now available on the Workers free plan (10,000 ops/day, 24 h retention). **v0.3: the project starts on the free plan** — the pipeline is `await fetch`-bound, so the free plan's CPU limit should hold; the $5/mo Paid plan is the documented fallback if it doesn't (§5.5).

### 5.3 ASR provider candidates — bake-off under a zero-cost constraint

Persian is the deciding constraint. Provider quality diverges sharply on it.

**Cost constraint (added v0.3):** the owner wants this at **$0/month**. That flips the default: Gemini single-stage via the Google AI Studio free tier is the pipeline to beat, Scribe is the paid challenger, and Workers AI Whisper is the third candidate. AC-000 still decides — but on a quality tie or near-tie, free wins. Free-tier data usage is accepted (§13).

| Provider | Persian quality | Price | Notes |
|---|---|---|---|
| **Google Gemini (audio understanding)** | Strong; ~5.9% CER reported for Google ASR on FLEURS Persian | **$0 on the AI Studio free tier** (paid: ~$1.00/M audio input tokens on Flash-tier) | Transcribes *and* normalizes in one call — see §5.4. **Default hypothesis.** |
| ElevenLabs Scribe v1 | **Best measured** — ~3.1% WER on FLEURS Persian, 5.5% on Common Voice; vendor-reported as beating Gemini and Whisper | $0.22/hr batch | Batch-oriented, simple multipart REST call. **Paid challenger** — free tier covers the bake-off but not ongoing use; must clearly beat Gemini single-stage in AC-000 to justify ~$3.50/mo. |
| Speechmatics | Good; explicitly supports Farsi + Dari + Tajik | Enterprise-tier | Overkill for one user |
| OpenAI Whisper / `gpt-4o-transcribe` | Weakest of the four on Persian; prone to hallucination loops | ~$0.36/hr (`whisper-1`) | Not recommended as primary |
| Cloudflare Workers AI (Whisper) | Same Whisper weaknesses | Cheapest, zero egress | Useful only as a fallback |

> ⚠️ **Verify before building.** All WER figures above are vendor- or benchmark-reported and were gathered from secondary sources. **AC-000** (§8) requires running your own 10-clip Persian benchmark against your actual voice messages before the provider is locked in. Vendor benchmarks use clean read speech; your inputs are phone-quality conversational Persian, which is a different problem.

### 5.4 Normalization pass: LLM cleanup (Gemini 3 Flash or equivalent)

Scribe returns accurate *words*. It does not reliably return correct ZWNJ, Persian punctuation, paragraph structure, or disfluency removal. A second LLM pass does that.

Since v0.3 the single-stage variant is the **default hypothesis**, not the escape hatch: send the audio straight to Gemini with a transcription+formatting prompt, skipping Scribe. One vendor, one call, $0 on the free tier. The two-stage Scribe→LLM pipeline is the challenger and must clearly win AC-000 to justify being the system's only paid component.

### 5.5 Cost model

**Decided (v0.3): the baseline runs at $0/month.** Assuming 30 minutes of voice per day (~15 hours/month):

| Line item | Monthly |
|---|---|
| Cloudflare free plan (Workers, Queues, R2, D1) | $0.00 |
| Gemini single-stage via AI Studio free tier | $0.00 |
| **Baseline total** | **$0.00/month** |

Each paid upgrade is independent and taken only when a free tier demonstrably fails:

| Trigger | Upgrade | Monthly |
|---|---|---|
| Workers free-plan CPU limit actually bites (unlikely — the pipeline is `await fetch`-bound) | Workers Paid plan | $5.00 |
| AC-000 shows Gemini's Persian clearly loses to Scribe | Scribe batch @ $0.22/hr × 15 hr, plus < $0.20 Flash-tier cleanup | ~$3.50 |
| Free-tier data-usage terms become unacceptable (§13) | Gemini paid tier — no training on content | ~$2–4 |

Worst case with every upgrade taken, this is still ~$9–12/month; the design goal is to take none of them. Quality remains the bar (§4) — but between pipelines of equal quality, free wins.

## 6. Architecture

```
Telegram
   │  POST /webhook/<random-path>
   │  header: X-Telegram-Bot-Api-Secret-Token
   ▼
┌────────────────────────────────────────┐
│  Producer Worker (Hono)                │
│  1. verify secret token header         │
│  2. authorize: from.id == OWNER_ID      │
│  3. dedup check on update_id (D1)      │
│  4. sendMessage "⏳ …"  → placeholder   │
│  5. queue.send(job)                    │
│  6. record update_id as seen (D1)      │
│  7. return 200 OK          (< 2 s)     │
└────────────────┬───────────────────────┘
                 │  Cloudflare Queue
                 ▼
┌────────────────────────────────────────┐
│  Consumer Worker                        │
│  0. load job → resume from last stage   │
│  1. getFile → file_path                 │
│  2. GET api.telegram.org/file/… → bytes │
│  3. PUT to R2 (idempotency + retry)     │
│  4. POST ElevenLabs Scribe (multipart)  │
│  5. LLM normalization pass              │
│  6. editMessageText (or sendDocument)   │
│  7. mark job done in D1                 │
│  on throw → queue retry (max 3) → DLQ   │
└────────────────────────────────────────┘
```

### 6.1 Why the placeholder-then-edit pattern

Telegram expects a webhook response promptly and will retry the update if it doesn't get one. Transcription takes tens of seconds. Replying immediately with a placeholder message, then editing it when the transcript lands, gives the user instant feedback and removes any coupling between Telegram's timeout and the ASR provider's latency.

### 6.2 Platform limits that shape the design

| Limit | Value | Consequence |
|---|---|---|
| Telegram `getFile` download | **20 MB** | At typical voice-note bitrates (~16 kbps Opus) this is roughly 2–3 hours of audio. Effectively a non-issue for voice notes, but MUST be handled with a clear error message rather than a crash. |
| Telegram message text | 4096 chars | Longer transcripts go out as a `.md` document via `sendDocument`. |
| Workers CPU time | **~10 ms/invocation on Free** (30 s default, up to 5 min on Paid) | CPU time excludes time spent awaiting `fetch`, so a 60 s ASR call does **not** consume CPU budget. Actual CPU use here is trivial — which is why the free plan is expected to hold (§5.5). |
| Workers subrequests | 1,000 (free) / 10,000+ (paid) | Not a factor — this pipeline makes ~5 subrequests per job. |
| Queue message size | 128 KB | Store audio in R2 and pass the key; never put audio bytes in a queue message. |

> ⚠️ **Verify:** Queue consumer maximum wall-clock duration, and whether the current ElevenLabs API imposes a per-request audio-length cap. Both should be confirmed against live docs during `/speckit.plan`.

> **Telegram Premium note (v0.3):** the owner has Premium; it changes nothing here. Premium perks are user-side — the Bot API is identical for all bots and the 20 MB `getFile` ceiling stands. Premium's built-in transcribe button is the "do nothing" alternative and fails the §4 bar (raw, unformatted output).

## 7. Functional requirements

Stable IDs so `tasks.md` and tests can reference them.

### 7.1 Access control

- **FR-001** The bot MUST process updates only when `message.from.id` equals the configured `OWNER_TELEGRAM_USER_ID`.
- **FR-002** Authorization MUST be on the numeric user ID, never `username` — usernames are reassignable.
- **FR-003** The webhook MUST be registered with a `secret_token`, and every request MUST be rejected with 401 unless `X-Telegram-Bot-Api-Secret-Token` matches. Comparison MUST be constant-time.
- **FR-004** The webhook path MUST contain a high-entropy random segment (defense in depth, not the primary control).
- **FR-005** Unauthorized senders MUST receive no reply and no acknowledgement of the bot's purpose. Log the attempt; do not respond. *(Rationale: a silent bot is not worth probing.)*
- **FR-006** Bot privacy mode MUST be enabled via BotFather, and the bot MUST NOT be added to any group.
- **FR-007** `OWNER_TELEGRAM_USER_ID` MUST come from an environment variable, never a hardcoded literal in source.

### 7.2 Ingestion

- **FR-010** The bot MUST accept `message.voice` — both forwarded and directly recorded.
- **FR-011** Forwarded voice messages MUST be handled identically to originals, regardless of `forward_origin` privacy settings.
- **FR-012** Non-voice inputs (text, photo, document, audio, video_note) **from the owner** MUST get a short, friendly "voice messages only in v1" reply. Unauthorized senders always get silence — FR-005 takes precedence.
- **FR-013** `/start` and `/help` MUST return a one-paragraph description of what the bot does.
- **FR-014** Files exceeding Telegram's 20 MB `getFile` ceiling MUST produce an explanatory error message, not a stack trace or silence.
- **FR-015** Duplicate `update_id` values MUST be ignored (Telegram retries on non-200).
- **FR-016** The `update_id` dedup record MUST be committed only after the job is successfully enqueued. A failure between the dedup check and the enqueue MUST leave no dedup record, so Telegram's retry of that update is processed rather than dropped as a duplicate. *(Otherwise a transient enqueue failure silently loses the message — violating Constitution art. 3.)*
- **FR-017** A caption attached to a voice message MUST be ignored.

### 7.3 Transcription pipeline

- **FR-020** Audio MUST be downloaded and persisted to R2 before the ASR call, keyed by `file_unique_id`.
- **FR-021** If an R2 object already exists for a `file_unique_id`, the download MUST be skipped.
- **FR-022** The ASR request MUST pin the language to Persian (`fa`) rather than relying on autodetection, unless multilingual mode is explicitly enabled. *(Autodetection is a common source of catastrophic failure on short or noisy Persian clips.)*
- **FR-023** Raw ASR output MUST be persisted alongside the cleaned output, so normalization-prompt regressions are diagnosable.
- **FR-024** The normalization pass MUST receive an explicit, constrained instruction: reformat only; never add, remove, summarize, translate, or answer content. Its system prompt MUST be a versioned file in the repo (`prompts/normalize-fa.v1.md`), not an inline string.
- **FR-025** The normalization output MUST be validated before delivery — see FR-026/027. On validation failure, the raw ASR text MUST be delivered with a "⚠️ raw output" marker rather than nothing.
- **FR-026** A length guard MUST reject normalized output shorter than 60% or longer than 140% of the raw transcript's character count. *(This catches the LLM silently summarizing — the single most likely quality failure.)* The bounds MUST be configuration values tuned against the golden set, not code constants — heavy disfluency removal legitimately compresses filler-heavy clips, so expect to adjust the floor (or switch the basis to word count) once real data exists.
- **FR-027** A script guard MUST reject output containing Arabic `ي` (U+064A) or `ك` (U+0643).
- **FR-028** All ASR and LLM calls MUST have explicit timeouts and MUST be retried with exponential backoff on 5xx/429, up to 3 attempts.
- **FR-029** The consumer MUST be stage-resumable: on queue redelivery it MUST skip the download when the R2 object exists (FR-021), skip the ASR call when the raw transcript is already persisted, skip normalization when the clean output is persisted, and skip delivery when the job status is already `delivered`. The same applies across jobs: a `file_unique_id` that already has a persisted transcript SHOULD reuse it instead of re-calling ASR (repeat forwards are free). *(Prevents duplicate ASR billing and double-edits of the user-facing message.)*

### 7.4 Delivery

- **FR-030** A placeholder message MUST be sent as a reply to the voice message, targeting delivery within 2 seconds of the webhook arriving. *(The 2 s figure is a target, not a hard gate — it rides on Telegram API latency outside our control.)* If the `sendMessage` call fails or times out, the job MUST still be enqueued with a null `placeholder_message_id`, and the consumer delivers the transcript as a new reply instead of an edit.
- **FR-031** The finished transcript MUST replace the placeholder via `editMessageText`, preserving the reply-to relationship with the original voice message.
- **FR-032** Transcripts over 4000 characters MUST be delivered as a `.md` document sent as a reply to the voice message, with the placeholder edited to a short "transcript attached ⬇" note (Telegram cannot deep-link between messages).
- **FR-033** Delivered text MUST NOT use Telegram MarkdownV2 unless every reserved character is escaped; plain text is the safe default.
- **FR-034** Every terminal failure MUST result in a human-readable message to the user containing a correlation ID. Silent failure is a defect.
- **FR-035** All user-facing copy — placeholder, `/start`, `/help`, the non-voice reply, and every error message — MUST be in Persian. Correlation IDs stay Latin/ASCII.

### 7.5 Observability

- **FR-040** Every job MUST log: `update_id`, `file_unique_id`, audio duration, ASR latency, LLM latency, character counts (raw + cleaned), outcome, correlation ID.
- **FR-041** Transcript *content* MUST NOT be written to logs. Persist it in R2/D1 only.
- **FR-042** Failures landing in the DLQ MUST be inspectable and manually replayable.

### 7.6 Retention & privacy

- **FR-050** All R2 objects for a job — audio and transcripts (raw + clean) — MUST be deleted after 30 days via an R2 lifecycle rule. *(Decision on §13 Q1: bounded privacy exposure — forwarded messages contain other people's speech — while keeping a reprocessing window for normalization-prompt regressions.)*
- **FR-051** D1 job rows carry metadata only (FR-041 keeps content out of them) and MAY be retained indefinitely.

## 8. Acceptance criteria

Written Given/When/Then so they translate directly into tests.

**AC-000 — Provider bake-off (blocks all implementation)**
Given 10 representative Persian voice messages from real chats (varying: noise, speed, phone vs. headset, some Persian-English code-switching),
When each is transcribed via Scribe→LLM, Gemini single-stage, and Workers AI Whisper,
Then the results are scored side-by-side against the saved NotebookLM transcript of the same clip — the quality bar itself serves as the reference (decided §13; accepting that NotebookLM's own occasional errors are inherited) — and the winning pipeline is recorded in `specs/001-voice-transcription/research.md` before any pipeline code is written.

**AC-001 — Happy path**
Given an authorized user forwards a 3-minute Persian voice message,
When the bot receives it,
Then a placeholder appears within 2 s and is replaced by a clean transcript within 90 s.

**AC-002 — Quality gate**
Given the AC-000 benchmark set,
When transcripts are produced by the chosen pipeline,
Then ≥ 8 of 10 are judged by the owner as "equal to or better than what NotebookLM returns for the same clip."
*This is a subjective gate on purpose. It is the actual product requirement; a WER number is a proxy for it.*

**AC-003 — Orthography**
Given any produced transcript,
When scanned programmatically,
Then it contains zero U+064A and zero U+0643 characters, and compound verbs use ZWNJ correctly in a spot-check of 20 samples.

**AC-004 — No summarization**
Given a 10-minute voice message,
When transcribed,
Then the delivered character count is within 60–140% of the raw ASR character count, and no sentence appears in the output that is absent in meaning from the raw transcript.

**AC-005 — Access control**
Given any Telegram user other than the owner sends a voice message,
When the webhook fires,
Then no reply is sent, no ASR call is made, no billing is incurred, and the attempt is logged.

**AC-006 — Forged webhook**
Given a POST to the webhook URL without a valid `X-Telegram-Bot-Api-Secret-Token`,
Then the response is 401 and nothing is enqueued.

**AC-007 — Oversized file**
Given a voice message whose file exceeds 20 MB,
Then the user receives a clear explanation of the limit and the job does not retry indefinitely.

**AC-008 — Idempotency**
Given Telegram redelivers the same `update_id`, or the queue redelivers a job after a mid-pipeline crash,
Then exactly one transcript is produced and exactly one ASR charge is incurred.

**AC-009 — Long transcript**
Given a transcript over 4000 characters,
Then it is delivered as a `.md` file and the placeholder is edited to reference it.

**AC-010 — Provider outage**
Given the ASR provider returns 503 on all 3 attempts,
Then the user receives a failure message with a correlation ID and the job lands in the DLQ.

## 9. Spec-driven development plan

Following GitHub Spec Kit conventions, where a **constitution** of non-negotiable principles governs how specs become code.

### 9.1 Project constitution

Draft articles for `/speckit.constitution`:

1. **Single-tenant by construction.** Owner-ID authorization is checked at the outermost boundary, before any other logic. No code path may reach an ASR call without passing it.
2. **The transcript is sacred.** No component may add, remove, reorder, summarize, or translate content. Formatting-only transformations, enforced by automated guards.
3. **Never fail silently.** Every error path terminates in a user-visible message with a correlation ID.
4. **Pure core, thin edges.** Transcript normalization, validation, and formatting are pure functions in `src/core/` with no I/O — unit-testable without network or Cloudflare bindings. Telegram, ASR, and storage live behind interfaces in `src/adapters/`.
5. **Prompts are source code.** Versioned files, code-reviewed, with a golden-transcript regression suite. A prompt change without a passing golden test is a breaking change.
6. **No secrets in source.** Secrets Store or `wrangler secret` only.
7. **Every FR maps to a test.** A functional requirement with no corresponding test is not implemented.

### 9.2 Repository layout

```
voicescribe/
├── .specify/
│   └── memory/constitution.md
├── specs/
│   └── 001-voice-transcription/
│       ├── spec.md          # ← this PRD, refined by /speckit.specify
│       ├── research.md      # ← AC-000 bake-off results
│       ├── plan.md          # ← /speckit.plan
│       ├── data-model.md
│       ├── contracts/
│       │   ├── telegram-webhook.schema.json
│       │   └── asr-provider.interface.ts
│       └── tasks.md         # ← /speckit.tasks
├── prompts/
│   └── normalize-fa.v1.md
├── src/
│   ├── index.ts             # Hono app, webhook route
│   ├── consumer.ts          # queue consumer
│   ├── core/                # pure, I/O-free
│   │   ├── authorize.ts
│   │   ├── normalize.ts
│   │   ├── validate.ts
│   │   └── format.ts
│   └── adapters/
│       ├── telegram.ts
│       ├── asr/             # scribe.ts | gemini.ts | workers-ai.ts
│       └── storage.ts
├── tests/
│   ├── unit/
│   ├── integration/         # vitest + @cloudflare/vitest-pool-workers
│   └── golden/              # fixture audio → expected transcript
└── wrangler.jsonc
```

### 9.3 Phases

| Phase | Deliverable | Gate |
|---|---|---|
| **0** | Constitution + this spec refined into `spec.md` | Owner sign-off |
| **1** | AC-000 provider bake-off → `research.md` | Winning pipeline chosen and justified |
| **2** | `plan.md` + contracts + data model | ASR provider interface finalized so providers stay swappable |
| **3** | Walking skeleton: webhook → auth → placeholder → hardcoded reply | AC-005, AC-006 pass |
| **4** | Full pipeline: R2 → ASR → normalize → deliver | AC-001, AC-002, AC-003, AC-004 pass |
| **5** | Resilience: retries, DLQ, oversized files, long transcripts, idempotency | AC-007–AC-010 pass |
| **6** | Golden-transcript regression suite + observability | All FRs mapped to tests |

**Phase 1 must not be skipped.** Building the whole pipeline and *then* discovering Scribe mishandles your particular accent or recording conditions is the most expensive failure mode available here.

Phase 1 is real work, not a side effect: the bake-off harness is a standalone script (not Worker code), and the references are saved NotebookLM transcripts of the same clips. It also starts with account setup — the owner currently has a Google AI Pro subscription but no API keys, and **AI Pro does not include Gemini API access**. A Gemini API key must be created via Google AI Studio (its free tier covers a 10-clip benchmark), plus an ElevenLabs account (free tier includes a Scribe allowance).

## 10. Data model (sketch)

```ts
// D1: jobs
{
  id: string;              // correlation ID (uuid)
  update_id: number;       // UNIQUE — idempotency key
  chat_id: number;
  voice_message_id: number;
  placeholder_message_id: number | null;
  file_unique_id: string;
  duration_sec: number;
  r2_audio_key: string | null;
  status: 'queued'|'downloading'|'transcribing'|'normalizing'|'delivered'|'failed';
  asr_provider: string;
  asr_ms: number | null;
  llm_ms: number | null;
  raw_chars: number | null;
  clean_chars: number | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

// R2
audio/{file_unique_id}.ogg
transcripts/{job_id}/raw.txt
transcripts/{job_id}/clean.md
```

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Persian ASR quality below NotebookLM** | Product fails its core premise | AC-000 bake-off *before* implementation; ASR behind a swappable interface (Constitution art. 4) so switching providers is a one-file change |
| **LLM normalizer silently summarizes** | Silent data loss — the worst failure mode, because the output still *looks* good | FR-026 length guard + AC-004 + golden regression suite |
| **LLM normalizer "answers" the content** | Wrong output entirely | Constrained prompt, versioned and regression-tested (FR-024) |
| **ASR hallucination loops on silence** | Garbage repeated text | Prefer Scribe over Whisper-family; add a repeated-n-gram detector in `validate.ts` |
| **Vendor pricing/API change** | Cost or breakage | Adapter interface; costs are small enough to absorb |
| **Free-tier limits or terms change** | Pipeline stops being $0 | Volume is tiny relative to today's free tiers; paid escape hatches are priced in §5.5 and the adapter interface makes switching a config change |
| **Bot token leak** | Anyone can read the webhook stream | Secret token + owner-ID check means a leaked token still yields no transcription; rotate via BotFather |
| **Benchmark figures in §5.3 are secondhand** | Wrong provider chosen | Treated as hypotheses, not facts — AC-000 is the source of truth |
| **NotebookLM-as-reference inherits its errors** | Bake-off could crown a pipeline that replicates NotebookLM's mistakes | Accepted by decision (§13): the bar is "as good as NotebookLM", not absolute truth — AC-002 stays subjective on purpose |

## 12. Parked for v2+

- Speaker diarization (Scribe already returns it; it's a formatting decision, not a new integration)
- Optional `/summary` command on an existing transcript
- Timestamps
- Audio files, video notes, forwarded videos (needs `ffmpeg` — which is *not* available on Workers; would require Cloudflare Containers or an external service)
- Long-audio support beyond 20 MB via a self-hosted Telegram Bot API server (raises the ceiling to 2 GB)
- English/German support, a `/lang` override toggle, and true code-switching mode
- Auto-export to Notion or Obsidian
- **Go migration** — if a container runtime is adopted (Cloudflare Containers / Fly.io / Cloud Run), the pipeline ports cleanly to idiomatic Go, and `ffmpeg` becomes available at the same time

## 13. Open questions — resolved

Resolved with the owner on 2026-08-07 (v0.2–v0.3 reviews):

1. **Retention** — 30-day R2 lifecycle rule, applied to audio *and* transcripts (FR-050).
2. **Numerals** — Persian digits (`۱۲۳`) throughout, config-overridable (§4).
3. **Mostly-English messages** — v1 always pins `fa` (FR-022); a `/lang` toggle is parked for v2 (§12).
4. **Chat scope** — strictly 1:1 DMs; FR-006 stands unchanged.
5. **Bot copy language** — Persian throughout, correlation IDs Latin/ASCII (FR-035).
6. **AC-000 references** — saved NotebookLM transcripts of the same clips, not hand-corrected ground truth (see §11 for the accepted risk).
7. **Retry design** — stage-resumable consumer (FR-029), not accept-the-rerun.
8. **Cost constraint (v0.3)** — $0/month baseline: Cloudflare free plan + Gemini single-stage on the AI Studio free tier. Paid upgrades only on the §5.5 triggers; quality ties go to the free option.
9. **Free-tier data usage (v0.3)** — accepted: Google may use free-tier audio/transcripts for product improvement, including human review. Revisit via the Gemini paid tier (~$2–4/mo) if this becomes uncomfortable — same API key, no code change.
10. **Telegram Premium (v0.3)** — owner has it; no impact on the design. Bot API limits are unchanged, and Premium's built-in transcription fails the §4 bar.
11. **Gemini-only bake-off (v0.4, 2026-10-15)** — ElevenLabs Scribe and Workers AI Whisper are parked, not rejected. AC-000 now compares Gemini models on the single-stage pipeline and still must pass AC-002. Scribe→LLM is un-parked only if no Gemini model passes (`research.md` §Decision rule). Sections 5.3–5.5 and AC-000 above keep the original three-way framing as history.
12. **No bake-off (v0.5, 2026-10-15)** — AC-000 is dropped entirely, superseding decision 11's model comparison and §9.3's "Phase 1 must not be skipped". The bot uses Gemini single-stage; live probes on 2026-10-15 set `gemini-3.5-flash` with `gemini-3.5-flash-lite` as fallback (`research.md` §Findings). AC-002 is judged on the first 10 real transcripts from the live bot. Accepted risk: quality is validated after the build, not before; mitigated by a config-only model switch and versioned prompts.

Still open — verify against live docs during Phase 2:

- Current Cloudflare Queues consumer wall-clock limit, and ElevenLabs' per-request audio duration cap.

---

## Appendix A — Sources

Figures in §5.3, §5.5, and §6.2 were gathered from the sources below. Vendor-reported benchmarks are marked as hypotheses to be validated by AC-000.

- [ElevenLabs — Meet Scribe](https://elevenlabs.io/blog/meet-scribe) — Persian WER claims
- [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) — $0.22/hr batch, $0.39/hr realtime
- [ElevenLabs Speech-to-Text docs](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
- [Speechmatics — Persian STT](https://www.speechmatics.com/speech-to-text/persian)
- [Speech-to-Text APIs in 2026: Benchmarks & Pricing](https://futureagi.substack.com/p/speech-to-text-apis-in-2026-benchmarks)
- [Telegram Bot API](https://core.telegram.org/bots/api) — `getFile` 20 MB limit
- [grammY — File Handling](https://grammy.dev/guide/files) — local Bot API server path to 2 GB
- [Cloudflare — Run Workers for up to 5 minutes of CPU-time](https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/)
- [Cloudflare — Workers subrequest limits raised](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
- [Cloudflare — Queues on the free plan](https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/)
- [Gemini API pricing breakdown](https://curlscape.com/blog/google-gemini-api-pricing-guide-2026)
- [GitHub Spec Kit — spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)
- [Spec-Driven Development with Spec Kit — Microsoft for Developers](https://developer.microsoft.com/blog/spec-driven-development-spec-kit/)
