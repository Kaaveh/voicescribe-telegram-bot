// Queue consumer (plan.md §4): stage-resumable download → transcribe → validate → deliver.
import transcribePrompt from '../prompts/transcribe-fa.v1.md';
import type { Deps } from './adapters/deps';
import { createJobs, type JobRow, type Jobs } from './adapters/db';
import { TranscriptionError, createGemini } from './adapters/gemini';
import { audioKey, createStorage, type Storage, type Transcripts } from './adapters/storage';
import { TELEGRAM_FILE_LIMIT, TelegramError, createTelegram, type Telegram } from './adapters/telegram';
import { formatDelivery, type Delivery } from './core/format';
import { DOCUMENT_POINTER, failed, fileTooLarge } from './core/messages';
import { parseBounds, validate } from './core/validate';
import type { Env, QueueJob } from './env';

/** Mirrors `max_retries` in wrangler.jsonc: a message is delivered at most 1 + 3 times. */
export const QUEUE_MAX_RETRIES = 3;

/** A failure no retry can fix: notify the user, mark failed, don't retry (AC-007). */
export class TerminalError extends Error {
  constructor(public readonly code: string, public readonly userMessage: (id: string) => string = failed) {
    super(code);
  }
}

export type Outcome = { kind: 'done' } | { kind: 'retry'; code: string; error: string } | { kind: 'terminal'; error: TerminalError };

interface Ctx {
  env: Env;
  deps: Deps;
  jobs: Jobs;
  storage: Storage;
  tg: Telegram;
}

export async function handleBatch(batch: MessageBatch<QueueJob>, env: Env, deps: Deps): Promise<void> {
  for (const msg of batch.messages) {
    const ctx: Ctx = {
      env,
      deps,
      jobs: createJobs(env.DB),
      storage: createStorage(env.AUDIO),
      tg: createTelegram(env.TELEGRAM_BOT_TOKEN, deps),
    };
    const { jobId } = msg.body;
    const outcome = await processJob(ctx, jobId);

    if (outcome.kind === 'done') {
      msg.ack();
      continue;
    }
    const lastAttempt = msg.attempts > QUEUE_MAX_RETRIES;
    if (outcome.kind === 'retry' && !lastAttempt) {
      const delaySeconds = 30 * msg.attempts;
      deps.log('job_retry', { correlation_id: jobId, attempt: msg.attempts, delay_s: delaySeconds, error_code: outcome.code, error: outcome.error });
      msg.retry({ delaySeconds });
      continue;
    }
    // Terminal, or retries exhausted: the user always hears about it (FR-034, art. III).
    const error = outcome.kind === 'terminal' ? outcome.error : new TerminalError(outcome.code);
    await failJob(ctx, jobId, error);
    if (outcome.kind === 'retry') msg.retry(); // exhausted → lands in the DLQ (AC-010, FR-042)
    else msg.ack();
  }
}

export async function processJob(ctx: Ctx, jobId: string): Promise<Outcome> {
  const { jobs, deps } = ctx;
  const job = await jobs.get(jobId);
  if (!job) {
    deps.log('job_missing', { correlation_id: jobId });
    return { kind: 'done' };
  }
  if (job.status === 'delivered' || job.status === 'failed') return { kind: 'done' }; // redelivery (AC-008)

  try {
    const audio = await ensureAudio(ctx, job);
    const { transcripts, provider, asrMs } = await ensureTranscripts(ctx, job, audio);

    const validation = validate(transcripts.raw, transcripts.clean, parseBounds(ctx.env.LENGTH_GUARD_MIN, ctx.env.LENGTH_GUARD_MAX));
    const delivery = formatDelivery({ ...transcripts, validation, numeralStyle: ctx.env.NUMERAL_STYLE, jobId });
    await deliver(ctx, job, delivery);

    await jobs.markDelivered(
      jobId,
      { asr_provider: provider, asr_ms: asrMs, raw_chars: transcripts.raw.length, clean_chars: transcripts.clean.length },
      deps.now(),
    );
    deps.log('job_delivered', {
      correlation_id: jobId,
      update_id: job.update_id,
      file_unique_id: job.file_unique_id,
      duration_sec: job.duration_sec,
      asr_provider: provider,
      asr_ms: asrMs,
      llm_ms: 0,
      raw_chars: transcripts.raw.length,
      clean_chars: transcripts.clean.length,
      length_ratio: Number.isFinite(validation.lengthRatio) ? Number(validation.lengthRatio.toFixed(3)) : null,
      guard_failures: validation.failures,
      delivery: delivery.kind,
      outcome: validation.ok ? 'delivered' : 'delivered_raw',
    });
    return { kind: 'done' };
  } catch (e) {
    if (e instanceof TerminalError) return { kind: 'terminal', error: e };
    if (e instanceof TranscriptionError && !e.retryable) return { kind: 'terminal', error: new TerminalError(e.code) };
    if (e instanceof TelegramError && !e.retryable) {
      if (e.fileTooBig) return { kind: 'terminal', error: new TerminalError('FILE_TOO_LARGE', fileTooLarge) };
      return { kind: 'terminal', error: new TerminalError(`TELEGRAM_${e.status}`) };
    }
    const code = e instanceof TranscriptionError ? e.code : e instanceof TelegramError ? `TELEGRAM_${e.status}` : 'INTERNAL';
    return { kind: 'retry', code, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * FR-020/021: audio lands in KV before ASR; an existing key skips the download.
 * Fresh bytes are handed on directly: KV caches the earlier miss, so reading
 * the key straight back can still return null.
 */
async function ensureAudio(ctx: Ctx, job: JobRow): Promise<{ key: string; bytes?: ArrayBuffer }> {
  const key = audioKey(job.file_unique_id);
  if (await ctx.storage.hasAudio(key)) return { key };
  if (job.file_size !== null && job.file_size > TELEGRAM_FILE_LIMIT) throw new TerminalError('FILE_TOO_LARGE', fileTooLarge);

  await ctx.jobs.setStatus(job.id, 'downloading');
  const file = await ctx.tg.getFile(job.file_id);
  if (file.file_size !== undefined && file.file_size > TELEGRAM_FILE_LIMIT) throw new TerminalError('FILE_TOO_LARGE', fileTooLarge);
  const bytes = await ctx.tg.downloadFile(file.file_path);
  await ctx.storage.putAudio(key, bytes, 'audio/ogg');
  await ctx.jobs.setAudioKey(job.id, key);
  return { key, bytes };
}

/** FR-023/029: persisted transcripts skip ASR — this job's own, or a prior job's for the same audio. */
async function ensureTranscripts(
  ctx: Ctx,
  job: JobRow,
  { key, bytes }: { key: string; bytes?: ArrayBuffer },
): Promise<{ transcripts: Transcripts; provider: string | null; asrMs: number | null }> {
  const own = await ctx.storage.getTranscripts(job.id);
  if (own) return { transcripts: own, provider: job.asr_provider, asrMs: job.asr_ms };

  const prior = await ctx.jobs.findReusable(job.file_unique_id, job.id);
  const reused = prior && (await ctx.storage.getTranscripts(prior.id));
  if (prior && reused) {
    await ctx.storage.putTranscripts(job.id, reused);
    ctx.deps.log('transcript_reused', { correlation_id: job.id, from_job: prior.id });
    return { transcripts: reused, provider: `reuse:${prior.id}`, asrMs: 0 };
  }

  await ctx.jobs.setStatus(job.id, 'transcribing');
  const audio = bytes ? { bytes, mimeType: 'audio/ogg' } : await ctx.storage.getAudio(key);
  if (!audio) throw new Error(`audio object vanished: ${key}`); // retry re-downloads
  const gemini = createGemini(
    {
      apiKey: ctx.env.GEMINI_API_KEY,
      model: ctx.env.GEMINI_MODEL,
      fallbackModel: ctx.env.GEMINI_FALLBACK_MODEL,
      prompt: transcribePrompt,
      promptVersion: 'transcribe-fa.v1',
    },
    ctx.deps,
  );
  const result = await gemini.transcribe(audio.bytes, audio.mimeType, job.id);
  const transcripts = { raw: result.raw, clean: result.clean };
  await ctx.storage.putTranscripts(job.id, transcripts);
  return { transcripts, provider: result.provider, asrMs: result.asrMs };
}

/** FR-030–032: edit the placeholder in place, or reply when there is none. */
async function deliver(ctx: Ctx, job: JobRow, delivery: Delivery): Promise<void> {
  const { tg } = ctx;
  if (delivery.kind === 'document') {
    await tg.sendDocument(job.chat_id, delivery.filename, delivery.text, job.voice_message_id);
    await replaceOrReply(tg, job, DOCUMENT_POINTER);
    return;
  }
  await replaceOrReply(tg, job, delivery.text);
}

async function replaceOrReply(tg: Telegram, job: JobRow, text: string): Promise<void> {
  if (job.placeholder_message_id !== null) {
    try {
      await tg.editMessageText(job.chat_id, job.placeholder_message_id, text);
      return;
    } catch (e) {
      // The owner may have deleted the placeholder; fall through to a fresh reply.
      if (!(e instanceof TelegramError && e.messageGone)) throw e;
    }
  }
  await tg.sendMessage(job.chat_id, text, job.voice_message_id);
}

async function failJob(ctx: Ctx, jobId: string, error: TerminalError): Promise<void> {
  const job = await ctx.jobs.get(jobId);
  if (!job) return;
  try {
    await replaceOrReply(ctx.tg, job, error.userMessage(jobId));
  } catch (e) {
    ctx.deps.log('failure_notice_failed', { correlation_id: jobId, error: String(e) });
  }
  await ctx.jobs.markFailed(jobId, error.code, ctx.deps.now());
  ctx.deps.log('job_failed', {
    correlation_id: jobId,
    update_id: job.update_id,
    file_unique_id: job.file_unique_id,
    duration_sec: job.duration_sec,
    error_code: error.code,
    outcome: 'failed',
  });
}
