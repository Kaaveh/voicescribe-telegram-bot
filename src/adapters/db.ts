// D1 job repository (data-model.md). Rows hold metadata only (FR-041).

export type JobStatus = 'received' | 'queued' | 'downloading' | 'transcribing' | 'normalizing' | 'delivered' | 'failed';

export interface JobRow {
  id: string;
  update_id: number;
  chat_id: number;
  voice_message_id: number;
  placeholder_message_id: number | null;
  file_id: string;
  file_unique_id: string;
  file_size: number | null;
  duration_sec: number;
  r2_audio_key: string | null;
  status: JobStatus;
  asr_provider: string | null;
  asr_ms: number | null;
  llm_ms: number | null;
  raw_chars: number | null;
  clean_chars: number | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export type NewJob = Pick<
  JobRow,
  'id' | 'update_id' | 'chat_id' | 'voice_message_id' | 'file_id' | 'file_unique_id' | 'file_size' | 'duration_sec' | 'created_at'
>;

export interface DeliveryMetrics {
  asr_provider: string | null;
  asr_ms: number | null;
  raw_chars: number;
  clean_chars: number;
}

export function createJobs(db: D1Database) {
  return {
    /** Step 1 of the dedup protocol: true if inserted, false if update_id already exists. */
    async insertReceived(job: NewJob): Promise<boolean> {
      const r = await db
        .prepare(
          `INSERT INTO jobs (id, update_id, chat_id, voice_message_id, file_id, file_unique_id, file_size, duration_sec, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)
           ON CONFLICT(update_id) DO NOTHING`,
        )
        .bind(job.id, job.update_id, job.chat_id, job.voice_message_id, job.file_id, job.file_unique_id, job.file_size, job.duration_sec, job.created_at)
        .run();
      return r.meta.changes === 1;
    },

    get: (id: string) => db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>(),

    getByUpdateId: (updateId: number) => db.prepare('SELECT * FROM jobs WHERE update_id = ?').bind(updateId).first<JobRow>(),

    async setPlaceholder(id: string, messageId: number): Promise<void> {
      await db.prepare('UPDATE jobs SET placeholder_message_id = ? WHERE id = ?').bind(messageId, id).run();
    },

    /** Only moves forward from 'received', so a late duplicate can't regress a running job. */
    async markQueued(id: string): Promise<void> {
      await db.prepare(`UPDATE jobs SET status = 'queued' WHERE id = ? AND status = 'received'`).bind(id).run();
    },

    async setStatus(id: string, status: JobStatus): Promise<void> {
      await db.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind(status, id).run();
    },

    async setAudioKey(id: string, key: string): Promise<void> {
      await db.prepare('UPDATE jobs SET r2_audio_key = ? WHERE id = ?').bind(key, id).run();
    },

    async markDelivered(id: string, m: DeliveryMetrics, now: number): Promise<void> {
      await db
        .prepare(
          `UPDATE jobs SET status = 'delivered', asr_provider = ?, asr_ms = ?, llm_ms = 0,
             raw_chars = ?, clean_chars = ?, error_code = NULL, completed_at = ? WHERE id = ?`,
        )
        .bind(m.asr_provider, m.asr_ms, m.raw_chars, m.clean_chars, now, id)
        .run();
    },

    async markFailed(id: string, errorCode: string, now: number): Promise<void> {
      await db
        .prepare(`UPDATE jobs SET status = 'failed', error_code = ?, completed_at = ? WHERE id = ?`)
        .bind(errorCode, now, id)
        .run();
    },

    /** FR-042 replay: a failed job goes back to 'queued'; resumes from its persisted stages. */
    async requeueFailed(id: string, chatId: number): Promise<boolean> {
      const r = await db
        .prepare(
          `UPDATE jobs SET status = 'queued', error_code = NULL, completed_at = NULL
           WHERE id = ? AND chat_id = ? AND status = 'failed'`,
        )
        .bind(id, chatId)
        .run();
      return r.meta.changes === 1;
    },

    /** Most recent delivered job for the same audio — cross-job transcript reuse (FR-029). */
    findReusable: (fileUniqueId: string, excludeId: string) =>
      db
        .prepare(
          `SELECT * FROM jobs WHERE file_unique_id = ? AND id != ? AND status = 'delivered'
           ORDER BY completed_at DESC LIMIT 1`,
        )
        .bind(fileUniqueId, excludeId)
        .first<JobRow>(),
  };
}

export type Jobs = ReturnType<typeof createJobs>;
