/**
 * Registers the Worker as the bot's webhook (plan.md §5). Idempotent.
 *
 *   TELEGRAM_BOT_TOKEN=… WEBHOOK_SECRET_TOKEN=… WEBHOOK_PATH_SEGMENT=… \
 *     npx tsx scripts/set-webhook.ts https://voicescribe.<sub>.workers.dev
 *
 * Prints nothing secret: the path segment is redacted from all output.
 */
const [workerUrl] = process.argv.slice(2);
const env = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
if (!workerUrl?.startsWith('https://')) throw new Error('usage: set-webhook.ts <https worker URL>');

const token = env('TELEGRAM_BOT_TOKEN');
const segment = env('WEBHOOK_PATH_SEGMENT');
const api = (method: string, body?: unknown) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json() as Promise<{ ok: boolean; description?: string; result?: Record<string, unknown> }>);

const redact = (s: string) => s.split(segment).join('<path-segment>');

const set = await api('setWebhook', {
  url: `${workerUrl.replace(/\/$/, '')}/webhook/${segment}`,
  secret_token: env('WEBHOOK_SECRET_TOKEN'),
  allowed_updates: ['message'],
  drop_pending_updates: true,
});
if (!set.ok) throw new Error(`setWebhook failed: ${set.description}`);

const info = await api('getWebhookInfo');
const r = info.result ?? {};
console.log(
  redact(
    JSON.stringify(
      { url: r.url, pending_update_count: r.pending_update_count, last_error_message: r.last_error_message ?? null, allowed_updates: r.allowed_updates },
      null,
      2,
    ),
  ),
);

export {};
