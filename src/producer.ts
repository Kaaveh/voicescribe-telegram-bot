// Webhook producer (plan.md §3): secret → auth → commands → dedup → placeholder → enqueue.
import { Hono } from 'hono';
import type { Deps } from './adapters/deps';
import { createJobs, type JobRow } from './adapters/db';
import { createTelegram } from './adapters/telegram';
import { classify, secretsEqual, type TelegramUpdate } from './core/authorize';
import { HELP, PLACEHOLDER, RETRY_NOT_FOUND, RETRY_QUEUED, VOICE_ONLY } from './core/messages';
import type { Env } from './env';

// FR-030: the placeholder is a 2 s target, never a reason to stall the webhook.
const PLACEHOLDER_TIMEOUT_MS = 3_000;

export function createApp(deps: Deps) {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/webhook/:segment', async (c) => {
    const env = c.env;
    // Defense in depth (FR-004), then the primary control (FR-003).
    if (!(await secretsEqual(c.req.param('segment'), env.WEBHOOK_PATH_SEGMENT))) return c.notFound();
    const header = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!(await secretsEqual(header, env.WEBHOOK_SECRET_TOKEN))) return c.text('unauthorized', 401);

    let update: TelegramUpdate;
    try {
      update = await c.req.json<TelegramUpdate>();
    } catch {
      deps.log('bad_update');
      return c.body(null, 200);
    }

    const verdict = classify(update, env.OWNER_TELEGRAM_USER_ID);
    const tg = createTelegram(env.TELEGRAM_BOT_TOKEN, deps);

    switch (verdict.kind) {
      case 'ignore':
        return c.body(null, 200);

      case 'unauthorized':
        // FR-005: log, never reply, never reach ASR (AC-005).
        deps.log('unauthorized', { update_id: update.update_id, from_id: verdict.fromId });
        return c.body(null, 200);

      case 'help':
      case 'other': {
        const text = verdict.kind === 'help' ? HELP : VOICE_ONLY;
        try {
          await tg.sendMessage(verdict.message.chat.id, text, verdict.kind === 'other' ? verdict.message.message_id : undefined);
        } catch (e) {
          deps.log('reply_failed', { update_id: update.update_id, kind: verdict.kind, error: String(e) });
        }
        return c.body(null, 200);
      }

      case 'retry': {
        const { message, jobId } = verdict;
        const jobs = createJobs(env.DB);
        const requeued = jobId !== null && (await jobs.requeueFailed(jobId, message.chat.id));
        if (requeued) {
          try {
            await env.JOBS.send({ jobId });
          } catch (e) {
            await jobs.markFailed(jobId, 'REQUEUE_FAILED', deps.now()); // stay replayable
            deps.log('enqueue_failed', { correlation_id: jobId, error: String(e) });
            return c.text('enqueue failed', 500);
          }
          deps.log('job_requeued', { correlation_id: jobId });
        }
        try {
          await tg.sendMessage(message.chat.id, requeued ? RETRY_QUEUED : RETRY_NOT_FOUND, message.message_id);
        } catch (e) {
          deps.log('reply_failed', { update_id: update.update_id, kind: 'retry', error: String(e) });
        }
        return c.body(null, 200);
      }

      case 'voice': {
        const { message } = verdict;
        const jobs = createJobs(env.DB);

        // Dedup protocol (data-model.md §Dedup, FR-015/016).
        const fresh = {
          id: deps.uuid(),
          update_id: update.update_id,
          chat_id: message.chat.id,
          voice_message_id: message.message_id,
          file_id: message.voice.file_id,
          file_unique_id: message.voice.file_unique_id,
          file_size: message.voice.file_size ?? null,
          duration_sec: message.voice.duration,
          created_at: deps.now(),
        };
        let job: Pick<JobRow, 'id' | 'placeholder_message_id'> = { id: fresh.id, placeholder_message_id: null };
        if (!(await jobs.insertReceived(fresh))) {
          const existing = await jobs.getByUpdateId(update.update_id);
          if (!existing || existing.status !== 'received') {
            deps.log('duplicate_update', { update_id: update.update_id });
            return c.body(null, 200);
          }
          job = existing; // an earlier attempt died before enqueue — finish it (FR-016)
        }

        if (job.placeholder_message_id === null) {
          try {
            const id = await tg.sendMessage(message.chat.id, PLACEHOLDER, message.message_id, { timeoutMs: PLACEHOLDER_TIMEOUT_MS });
            await jobs.setPlaceholder(job.id, id);
          } catch (e) {
            // FR-030: enqueue anyway; the consumer replies instead of editing.
            deps.log('placeholder_failed', { correlation_id: job.id, error: String(e) });
          }
        }

        try {
          await env.JOBS.send({ jobId: job.id });
        } catch (e) {
          // Non-200 makes Telegram retry; the row stays 'received' so the retry is processed (FR-016).
          deps.log('enqueue_failed', { correlation_id: job.id, error: String(e) });
          return c.text('enqueue failed', 500);
        }
        await jobs.markQueued(job.id);
        deps.log('job_queued', {
          correlation_id: job.id,
          update_id: update.update_id,
          file_unique_id: fresh.file_unique_id,
          duration_sec: fresh.duration_sec,
        });
        return c.body(null, 200);
      }
    }
  });

  return app;
}
