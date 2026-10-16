import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createJobs } from '../../src/adapters/db';
import { audioKey, createStorage } from '../../src/adapters/storage';
import { handleBatch } from '../../src/consumer';
import { MESSAGE_LIMIT } from '../../src/core/format';
import { DOCUMENT_POINTER, PLACEHOLDER, RAW_MARKER } from '../../src/core/messages';
import type { QueueJob } from '../../src/env';
import { createFakes, geminiErr, geminiOut, tgErr } from '../helpers/fakes';

const OWNER = Number(env.OWNER_TELEGRAM_USER_ID);
const jobs = createJobs(env.DB);
const storage = createStorage(env.AUDIO);
let seq = 0;

/** A queued job as the producer leaves it. Unique file IDs keep KV state per test. */
async function seedJob(over: { fileSize?: number | null; placeholder?: number | null; uniq?: string } = {}) {
  const n = ++seq;
  const id = crypto.randomUUID();
  await jobs.insertReceived({
    id,
    update_id: 900_000 + n + Math.floor(Math.random() * 1e6),
    chat_id: OWNER,
    voice_message_id: 77,
    file_id: `FILE-${n}`,
    file_unique_id: over.uniq ?? `UNIQ-${id}`,
    file_size: over.fileSize === undefined ? 4000 : over.fileSize,
    duration_sec: 12,
    created_at: 1,
  });
  if (over.placeholder !== null) await jobs.setPlaceholder(id, over.placeholder ?? 500);
  await jobs.markQueued(id);
  return id;
}

async function run(fakes: ReturnType<typeof createFakes>, jobId: string, attempts = 1) {
  const batch = createMessageBatch<QueueJob>('voicescribe-jobs', [{ id: `msg-${jobId}`, timestamp: new Date(), attempts, body: { jobId } }]);
  const ctx = createExecutionContext();
  await handleBatch(batch, env, fakes.deps);
  return getQueueResult(batch, ctx);
}

const editedText = (f: ReturnType<typeof createFakes>) => f.callsTo('editMessageText').map((c) => (c.body as { text: string }).text);

describe('queue consumer', () => {
  it('AC-001 (consumer half): downloads, transcribes, edits the placeholder, marks delivered', async () => {
    const f = createFakes();
    const id = await seedJob();
    const result = await run(f, id);

    expect(result.explicitAcks).toEqual([`msg-${id}`]);
    expect(f.callsTo('getFile')[0]?.body).toEqual({ file_id: expect.stringMatching(/^FILE-/) });
    const job = await jobs.get(id);
    expect(await storage.hasAudio(audioKey(job!.file_unique_id))).toBe(true);
    // Gemini got the file by reference, with the versioned prompt.
    const gen = f.callsTo('gemini:generate')[0]!;
    expect(gen.url).toContain('/models/gemini-3.5-flash:generateContent');
    const parts = (gen.body as { contents: { parts: Record<string, unknown>[] }[] }).contents[0]!.parts;
    expect(parts[0]).toEqual({ fileData: { mimeType: 'audio/ogg', fileUri: 'https://g/files/abc' } });
    expect(String(parts[1]!.text)).toContain('Persian (Farsi) transcription engine');
    expect(f.callsTo('gemini:delete')).toHaveLength(1);
    // Placeholder edited with clean text, digits converted (PRD §13 decision 2).
    expect(editedText(f)).toEqual(['سلام. امروز ساعت ۱۰ جلسه داریم.']);
    expect(job).toMatchObject({ status: 'delivered', asr_provider: 'gemini-single:gemini-3.5-flash', raw_chars: 29, clean_chars: 31 });
    // FR-023: raw and clean persisted.
    expect(await storage.getTranscripts(id)).toEqual({ raw: 'سلام امروز ساعت 10 جلسه داریم', clean: 'سلام. امروز ساعت 10 جلسه داریم.' });
    // FR-040/041: metrics logged, content never.
    const log = f.logs.find((l) => l.event === 'job_delivered')!;
    expect(log.fields).toMatchObject({ correlation_id: id, raw_chars: 29, outcome: 'delivered' });
    expect(JSON.stringify(f.logs)).not.toContain('جلسه');
  });

  it('AC-008: a redelivered job resumes from persisted artifacts — no download, no ASR', async () => {
    const f = createFakes();
    const id = await seedJob();
    const job = await jobs.get(id);
    await storage.putAudio(audioKey(job!.file_unique_id), new ArrayBuffer(4), 'audio/ogg');
    await storage.putTranscripts(id, { raw: 'سلام', clean: 'سلام.' });
    await jobs.setStatus(id, 'transcribing');

    await run(f, id, 2);
    expect(f.callsTo('getFile')).toHaveLength(0);
    expect(f.callsTo('gemini:generate')).toHaveLength(0);
    expect(editedText(f)).toEqual(['سلام.']);
    expect((await jobs.get(id))?.status).toBe('delivered');
  });

  it('AC-008: an already-delivered job is acked untouched', async () => {
    const f = createFakes();
    const id = await seedJob();
    await jobs.markDelivered(id, { asr_provider: 'x', asr_ms: 1, raw_chars: 1, clean_chars: 1 }, 1);
    const result = await run(f, id, 2);
    expect(result.explicitAcks).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
  });

  it('FR-029: a repeat forward of the same audio reuses the transcript', async () => {
    const uniq = `UNIQ-shared-${crypto.randomUUID()}`;
    const first = await seedJob({ uniq });
    await run(createFakes(), first);
    const f = createFakes();
    const second = await seedJob({ uniq });
    await run(f, second);
    expect(f.callsTo('getFile')).toHaveLength(0); // audio already in KV
    expect(f.callsTo('gemini:generate')).toHaveLength(0);
    expect((await jobs.get(second))).toMatchObject({ status: 'delivered', asr_provider: `reuse:${first}` });
  });

  it('AC-007: a file over 20 MB gets a clear Persian message, no download, no retry', async () => {
    const f = createFakes();
    const id = await seedJob({ fileSize: 21 * 1024 * 1024 });
    const result = await run(f, id);
    expect(result.explicitAcks).toEqual([`msg-${id}`]);
    expect(result.retryMessages).toHaveLength(0);
    expect(f.callsTo('getFile')).toHaveLength(0);
    expect(editedText(f)[0]).toContain('۲۰ مگابایت');
    expect(editedText(f)[0]).toContain(id);
    expect(await jobs.get(id)).toMatchObject({ status: 'failed', error_code: 'FILE_TOO_LARGE' });
  });

  it("AC-007: Telegram's own 'file is too big' is terminal too", async () => {
    const f = createFakes();
    f.respond('getFile', () => tgErr(400, 'Bad Request: file is too big'));
    const id = await seedJob({ fileSize: null });
    const result = await run(f, id);
    expect(result.retryMessages).toHaveLength(0);
    expect(await jobs.get(id)).toMatchObject({ status: 'failed', error_code: 'FILE_TOO_LARGE' });
  });

  it('AC-010: provider outage retries with backoff, tries the fallback model, then notifies and lands in the DLQ', async () => {
    const f = createFakes();
    const id = await seedJob();
    for (let i = 0; i < 20; i++) f.respond('gemini:generate', () => geminiErr(503));

    const first = await run(f, id, 1);
    expect(first.retryMessages).toMatchObject([{ msgId: `msg-${id}` }]);
    expect(f.logs.find((l) => l.event === 'job_retry')?.fields).toMatchObject({ attempt: 1, delay_s: 30, error_code: 'GEMINI_UNAVAILABLE' });
    expect(f.callsTo('gemini:generate').map((c) => c.url.match(/models\/([^:]+)/)![1])).toEqual([
      'gemini-3.5-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(editedText(f)).toEqual([]); // the user isn't told yet
    expect((await jobs.get(id))?.status).toBe('transcribing');

    const last = await run(f, id, 4);
    expect(last.retryMessages).toHaveLength(1); // exhausted → DLQ
    const notice = editedText(f).at(-1)!;
    expect(notice).toContain('کد پیگیری');
    expect(notice).toContain(id);
    expect(await jobs.get(id)).toMatchObject({ status: 'failed', error_code: 'GEMINI_UNAVAILABLE' });
  });

  it('AC-009: a long transcript goes out as a .md document and the placeholder points to it', async () => {
    const f = createFakes();
    const long = 'متن '.repeat(MESSAGE_LIMIT / 2);
    f.respond('gemini:generate', () => geminiOut(long, long));
    const id = await seedJob();
    await run(f, id);
    const doc = f.callsTo('sendDocument')[0]!.body as Record<string, string>;
    expect(doc.document).toBe(`<file:transcript-${id.slice(0, 8)}.md>`);
    expect(JSON.parse(doc.reply_parameters!)).toMatchObject({ message_id: 77 });
    expect(editedText(f)).toEqual([DOCUMENT_POINTER]);
  });

  it('FR-025: output failing a guard is delivered as marked raw text', async () => {
    const f = createFakes();
    f.respond('gemini:generate', () => geminiOut('سلام دوست من كتاب', 'سلام دوست من. كتاب')); // Arabic kaf
    const id = await seedJob();
    await run(f, id);
    expect(editedText(f)).toEqual([`${RAW_MARKER}\n\nسلام دوست من کتاب`]); // raw, letter variant fixed
    const log = f.logs.find((l) => l.event === 'job_delivered')!;
    expect(log.fields).toMatchObject({ outcome: 'delivered_raw', guard_failures: ['SCRIPT_GUARD'] });
  });

  it('FR-030: with no placeholder, the transcript is a new reply to the voice message', async () => {
    const f = createFakes();
    const id = await seedJob({ placeholder: null });
    await run(f, id);
    expect(f.callsTo('editMessageText')).toHaveLength(0);
    expect(f.callsTo('sendMessage')[0]?.body).toMatchObject({ reply_parameters: { message_id: 77 } });
  });

  it('falls back to a reply when the placeholder was deleted', async () => {
    const f = createFakes();
    f.respond('editMessageText', () => tgErr(400, 'Bad Request: message to edit not found'));
    const id = await seedJob();
    await run(f, id);
    expect(f.callsTo('sendMessage')).toHaveLength(1);
    expect((await jobs.get(id))?.status).toBe('delivered');
  });

  it("treats Telegram's 'message is not modified' as already delivered", async () => {
    const f = createFakes();
    f.respond('editMessageText', () => tgErr(400, 'Bad Request: message is not modified'));
    const id = await seedJob();
    await run(f, id);
    expect(f.callsTo('sendMessage')).toHaveLength(0);
    expect((await jobs.get(id))?.status).toBe('delivered');
  });

  it('never leaves the placeholder text in place on failure', async () => {
    const f = createFakes();
    f.respond('gemini:generate', () => new Response('{"error":{"code":400}}', { status: 400 }));
    const id = await seedJob();
    const result = await run(f, id);
    expect(result.retryMessages).toHaveLength(0); // 400 is not retryable
    expect(editedText(f)).toHaveLength(1);
    expect(editedText(f)[0]).not.toBe(PLACEHOLDER);
    expect(await jobs.get(id)).toMatchObject({ status: 'failed', error_code: 'GEMINI_REJECTED' });
  });

  it('FR-050: every stored key expires 30 days after it is written', async () => {
    const f = createFakes();
    const id = await seedJob();
    await run(f, id);
    const job = await jobs.get(id);
    const now = Date.now() / 1000;
    for (const prefix of [audioKey(job!.file_unique_id), `transcripts/${id}`]) {
      const { keys } = await env.AUDIO.list({ prefix });
      expect(keys).toHaveLength(1);
      expect(keys[0]!.expiration! - now).toBeGreaterThan(30 * 86400 - 300);
      expect(keys[0]!.expiration! - now).toBeLessThanOrEqual(30 * 86400 + 5);
    }
  });

  it('FR-020: a first run transcribes without reading back the audio it just stored', async () => {
    // Real KV caches the initial miss at the edge, so a read straight after the put can return null.
    const staleMissKv = {
      get: async () => null,
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      put: (...args: Parameters<KVNamespace['put']>) => env.AUDIO.put(...args),
    } as unknown as KVNamespace;
    const f = createFakes();
    const id = await seedJob();
    const batch = createMessageBatch<QueueJob>('voicescribe-jobs', [{ id: `msg-${id}`, timestamp: new Date(), attempts: 1, body: { jobId: id } }]);
    await handleBatch(batch, { ...env, AUDIO: staleMissKv }, f.deps);
    expect((await jobs.get(id))?.status).toBe('delivered');
    expect(f.callsTo('gemini:generate')).toHaveLength(1);
  });
});
