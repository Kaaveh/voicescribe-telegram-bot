# Data Model — 001 Voice Transcription

## D1 schema (`migrations/0001_jobs.sql`)

```sql
CREATE TABLE jobs (
  id                     TEXT    PRIMARY KEY,          -- correlation ID (uuid v4)
  update_id              INTEGER NOT NULL UNIQUE,      -- idempotency key (FR-015)
  chat_id                INTEGER NOT NULL,
  voice_message_id       INTEGER NOT NULL,
  placeholder_message_id INTEGER,                      -- NULL if sendMessage failed (FR-030)
  file_id                TEXT    NOT NULL,             -- for getFile; the queue message carries only jobId
  file_unique_id         TEXT    NOT NULL,
  file_size              INTEGER,                      -- from the update, if Telegram sent it (FR-014 pre-check)
  duration_sec           INTEGER NOT NULL,
  r2_audio_key           TEXT,
  status                 TEXT    NOT NULL DEFAULT 'received'
                         CHECK (status IN ('received','queued','downloading',
                                           'transcribing','normalizing',
                                           'delivered','failed')),
  asr_provider           TEXT,
  asr_ms                 INTEGER,
  llm_ms                 INTEGER,
  raw_chars              INTEGER,
  clean_chars            INTEGER,
  error_code             TEXT,
  created_at             INTEGER NOT NULL,             -- epoch ms
  completed_at           INTEGER
);

CREATE INDEX idx_jobs_file_unique_id ON jobs(file_unique_id);
CREATE INDEX idx_jobs_status         ON jobs(status);
```

Delta vs. PRD §10 sketch: a `received` status precedes `queued` — it exists to
make dedup race-free (below). D1 rows are metadata-only (FR-041) and retained
indefinitely (FR-051).

## Status state machine

```
received → queued → downloading → transcribing → normalizing → delivered
                \______________________________________________→ failed
```

The consumer resumes from the last completed stage (FR-029); artifacts are the
source of truth for stage completion (KV audio entry, transcripts entry),
with `status` as the fast path.

## Dedup protocol (FR-015 + FR-016, race-free)

Producer, per update:

1. `INSERT INTO jobs (..., status='received') ON CONFLICT(update_id) DO NOTHING`.
2. If the insert **conflicted**: read the existing row.
   - status ≠ `received` → duplicate delivery → return 200, do nothing (FR-015).
   - status = `received` → a previous attempt died before enqueue → continue
     (this is Telegram's retry doing its job — FR-016).
3. Send placeholder (skip if the row already has `placeholder_message_id`)
   and record its ID immediately, so a retried update doesn't send a second one.
4. `queue.send(job)` — on failure return 500 so Telegram retries.
5. `UPDATE jobs SET status='queued' WHERE id=? AND status='received'`.
6. Return 200.

A failure at step 3–5 leaves the row in `received`, so the redelivered update
is reprocessed instead of dropped — no lost messages, no duplicate transcripts.

Replay (FR-042): the owner sends `/retry` as a reply to a failure notice (or
`/retry <id>`). A `failed` row of the same chat goes back to `queued` and is
re-enqueued; the consumer resumes from whatever stages are already persisted.

## KV layout (namespace `voicescribe`, binding `AUDIO`)

```
audio/{file_unique_id}.ogg          -- FR-020/021; shared across jobs
transcripts/{job_id}                -- FR-023; JSON {raw, clean}, written in one put
```

Every key is written with a 30-day `expirationTtl` (FR-050). Cross-job
reuse (FR-029): before calling ASR, look up a prior `delivered` job with the
same `file_unique_id` and reuse its transcripts if the entry still exists. The D1 column keeps its
historical name `r2_audio_key`; it holds the KV key.

## Queue message (≤ 128 KB — key/IDs only, never audio)

```ts
{ jobId: string }   // everything else is loaded from D1 by the consumer
```
