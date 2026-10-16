-- Schema from specs/001-voice-transcription/data-model.md (T023).
-- D1 rows are metadata only; transcript content lives in R2 (FR-041).
CREATE TABLE jobs (
  id                     TEXT    PRIMARY KEY,          -- correlation ID (uuid v4)
  update_id              INTEGER NOT NULL UNIQUE,      -- idempotency key (FR-015)
  chat_id                INTEGER NOT NULL,
  voice_message_id       INTEGER NOT NULL,
  placeholder_message_id INTEGER,                      -- NULL if sendMessage failed (FR-030)
  file_id                TEXT    NOT NULL,
  file_unique_id         TEXT    NOT NULL,
  file_size              INTEGER,
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
