import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createJobs } from '../../src/adapters/db';
import { HELP, PLACEHOLDER, RETRY_NOT_FOUND, RETRY_QUEUED, VOICE_ONLY, failed } from '../../src/core/messages';
import { createApp } from '../../src/producer';
import { createFakes, fakeQueue, tgErr } from '../helpers/fakes';

const SECRET = env.WEBHOOK_SECRET_TOKEN;
const PATH = `/webhook/${env.WEBHOOK_PATH_SEGMENT}`;
const OWNER = Number(env.OWNER_TELEGRAM_USER_ID);

let updateId = 1;
const voiceUpdate = (over: { from?: number; update_id?: number } = {}) => ({
  update_id: over.update_id ?? updateId++,
  message: {
    message_id: 77,
    date: 0,
    from: { id: over.from ?? OWNER },
    chat: { id: over.from ?? OWNER, type: 'private' },
    voice: { file_id: 'FILE', file_unique_id: 'UNIQ', duration: 12, mime_type: 'audio/ogg', file_size: 4000 },
  },
});
const textUpdate = (text: string) => ({
  update_id: updateId++,
  message: { message_id: 78, date: 0, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text },
});

function setup() {
  const fakes = createFakes();
  const q = fakeQueue();
  const app = createApp(fakes.deps);
  const post = async (body: unknown, opts: { secret?: string | null; path?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.secret !== null) headers['x-telegram-bot-api-secret-token'] = opts.secret ?? SECRET;
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`https://bot.example${opts.path ?? PATH}`, { method: 'POST', headers, body: JSON.stringify(body) }),
      { ...env, JOBS: q.queue },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };
  return { fakes, q, post };
}

describe('webhook producer', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('AC-006: rejects a forged webhook with 401 and enqueues nothing', async () => {
    expect((await t.post(voiceUpdate(), { secret: 'wrong' })).status).toBe(401);
    expect((await t.post(voiceUpdate(), { secret: null })).status).toBe(401);
    expect(t.q.sent).toHaveLength(0);
    expect(t.fakes.calls).toHaveLength(0);
  });

  it('FR-004: unknown path segment is a 404', async () => {
    expect((await t.post(voiceUpdate(), { path: '/webhook/guess' })).status).toBe(404);
    expect(t.q.sent).toHaveLength(0);
  });

  it('AC-005: non-owner gets silence, nothing enqueued, attempt logged', async () => {
    const res = await t.post(voiceUpdate({ from: 4242 }));
    expect(res.status).toBe(200);
    expect(t.fakes.calls).toHaveLength(0);
    expect(t.q.sent).toHaveLength(0);
    expect(t.fakes.logs).toContainEqual({ event: 'unauthorized', fields: expect.objectContaining({ from_id: 4242 }) });
  });

  it('FR-013/012: /start gets help; other input gets voice-only reply', async () => {
    await t.post(textUpdate('/start'));
    await t.post(textUpdate('hello'));
    const sent = t.fakes.callsTo('sendMessage').map((c) => (c.body as { text: string }).text);
    expect(sent).toEqual([HELP, VOICE_ONLY]);
    expect(t.q.sent).toHaveLength(0);
  });

  it('AC-001 (producer half): owner voice → placeholder reply + job queued', async () => {
    const res = await t.post(voiceUpdate());
    expect(res.status).toBe(200);
    const [ph] = t.fakes.callsTo('sendMessage');
    expect(ph?.body).toMatchObject({ text: PLACEHOLDER, reply_parameters: { message_id: 77 } });
    expect(t.q.sent).toHaveLength(1);
    const job = await createJobs(env.DB).get(t.q.sent[0]!.jobId);
    expect(job).toMatchObject({ status: 'queued', placeholder_message_id: 500, file_unique_id: 'UNIQ', chat_id: OWNER });
  });

  it('AC-008 / FR-015: a redelivered update_id is ignored', async () => {
    const u = voiceUpdate();
    await t.post(u);
    await t.post(u);
    expect(t.q.sent).toHaveLength(1);
    expect(t.fakes.callsTo('sendMessage')).toHaveLength(1);
  });

  it('FR-016: an enqueue failure returns 500, and Telegram\'s retry completes the job without a second placeholder', async () => {
    const u = voiceUpdate();
    t.q.failOnce();
    expect((await t.post(u)).status).toBe(500);
    expect((await createJobs(env.DB).getByUpdateId(u.update_id))?.status).toBe('received');
    expect((await t.post(u)).status).toBe(200);
    expect(t.q.sent).toHaveLength(1);
    expect(t.fakes.callsTo('sendMessage')).toHaveLength(1);
    expect((await createJobs(env.DB).getByUpdateId(u.update_id))?.status).toBe('queued');
  });

  it('FR-030: a failed placeholder still enqueues, with a null placeholder ID', async () => {
    t.fakes.respond('sendMessage', () => tgErr(500, 'Internal Server Error'));
    expect((await t.post(voiceUpdate())).status).toBe(200);
    const job = await createJobs(env.DB).get(t.q.sent[0]!.jobId);
    expect(job?.placeholder_message_id).toBeNull();
    expect(job?.status).toBe('queued');
  });

  it('answers 200 to malformed JSON so Telegram does not retry garbage', async () => {
    const ctx = createExecutionContext();
    const res = await createApp(t.fakes.deps).fetch(
      new Request(`https://bot.example${PATH}`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: '{nope' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it('FR-042: /retry as a reply to a failure notice requeues the failed job', async () => {
    await t.post(voiceUpdate());
    const jobId = t.q.sent[0]!.jobId;
    const jobs = createJobs(env.DB);
    await jobs.markFailed(jobId, 'GEMINI_UNAVAILABLE', 1);

    await t.post({
      update_id: updateId++,
      message: { message_id: 90, date: 0, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: '/retry', reply_to_message: { message_id: 500, text: failed(jobId) } },
    });
    expect(t.q.sent.map((m) => m.jobId)).toEqual([jobId, jobId]);
    expect(await jobs.get(jobId)).toMatchObject({ status: 'queued', error_code: null });
    expect((t.fakes.callsTo('sendMessage').at(-1)?.body as { text: string }).text).toBe(RETRY_QUEUED);
  });

  it('FR-042: /retry refuses unknown or non-failed jobs', async () => {
    await t.post(voiceUpdate());
    const jobId = t.q.sent[0]!.jobId; // queued, not failed
    await t.post(textUpdate(`/retry ${jobId}`));
    await t.post(textUpdate('/retry'));
    expect(t.q.sent).toHaveLength(1);
    const replies = t.fakes.callsTo('sendMessage').slice(-2).map((c) => (c.body as { text: string }).text);
    expect(replies).toEqual([RETRY_NOT_FOUND, RETRY_NOT_FOUND]);
  });
});
