// Fake Telegram + Gemini servers behind an injected fetch, plus deterministic deps.
import type { Deps } from '../../src/adapters/deps';
import type { QueueJob } from '../../src/env';

export interface Call {
  method: string; // Telegram method, or "gemini:<op>"
  url: string;
  body: unknown;
}

type Responder = (call: Call) => Response | Promise<Response>;

const tgOk = (result: unknown) => Response.json({ ok: true, result });
export const tgErr = (status: number, description: string, retryAfter?: number) =>
  Response.json({ ok: false, error_code: status, description, parameters: retryAfter ? { retry_after: retryAfter } : undefined }, { status });
export const geminiOut = (verbatim: string, formatted: string) =>
  Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ verbatim, formatted }) }] }, finishReason: 'STOP' }] });
export const geminiErr = (status: number) => Response.json({ error: { code: status, status: 'UNAVAILABLE' } }, { status });

export function createFakes() {
  const calls: Call[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  let nextMessageId = 500;
  const overrides = new Map<string, Responder[]>(); // FIFO per method

  const defaults: Record<string, Responder> = {
    sendMessage: () => tgOk({ message_id: nextMessageId++ }),
    editMessageText: () => tgOk(true),
    sendDocument: () => tgOk({ message_id: nextMessageId++ }),
    getFile: () => tgOk({ file_id: 'f', file_path: 'voice/file_1.oga', file_size: 1234 }),
    downloadFile: () => new Response(new Uint8Array([79, 103, 103, 83, 1, 2, 3])), // "OggS…"
    'gemini:start': () => new Response('{}', { headers: { 'x-goog-upload-url': 'https://upload.example/session-1' } }),
    'gemini:upload': () => Response.json({ file: { name: 'files/abc', uri: 'https://g/files/abc', mimeType: 'audio/ogg', state: 'ACTIVE' } }),
    'gemini:generate': () => geminiOut('سلام امروز ساعت 10 جلسه داریم', 'سلام. امروز ساعت 10 جلسه داریم.'),
    'gemini:delete': () => new Response('{}'),
  };

  function methodOf(url: string, init?: RequestInit): string {
    const u = new URL(url);
    if (u.hostname === 'api.telegram.org') {
      if (u.pathname.startsWith('/file/')) return 'downloadFile';
      return u.pathname.split('/').pop()!;
    }
    if (u.hostname === 'upload.example') return 'gemini:upload';
    if (u.pathname === '/upload/v1beta/files') return 'gemini:start';
    if (u.pathname.endsWith(':generateContent')) return 'gemini:generate';
    if (init?.method === 'DELETE') return 'gemini:delete';
    return 'gemini:get';
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = methodOf(url, init);
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    } else if (body instanceof FormData) {
      body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file:${(v as File).name}>`]));
    }
    const call = { method, url, body };
    calls.push(call);
    const queued = overrides.get(method);
    const responder = queued?.length ? queued.shift()! : defaults[method];
    if (!responder) throw new Error(`no fake for ${method}`);
    return responder(call);
  };

  const deps: Deps = {
    fetch: fetchFn,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    uuid: () => crypto.randomUUID(), // D1 persists across tests in a file, so IDs must not repeat
    log: (event, fields = {}) => {
      logs.push({ event, fields });
    },
  };

  return {
    deps,
    calls,
    logs,
    /** Queue one-shot responses for a method, consumed in order before the default. */
    respond(method: string, ...responders: Responder[]) {
      overrides.set(method, [...(overrides.get(method) ?? []), ...responders]);
    },
    callsTo: (method: string) => calls.filter((c) => c.method === method),
  };
}

export function fakeQueue() {
  const sent: QueueJob[] = [];
  let failNext = false;
  const queue = {
    async send(body: QueueJob) {
      if (failNext) {
        failNext = false;
        throw new Error('queue unavailable');
      }
      sent.push(body);
    },
    async sendBatch() {
      throw new Error('not used');
    },
  } as unknown as Queue<QueueJob>;
  return { queue, sent, failOnce: () => (failNext = true) };
}
