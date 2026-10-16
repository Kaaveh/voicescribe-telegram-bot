// Telegram Bot API adapter (FR-014, FR-030–033).
import type { Deps } from './deps';

export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024; // getFile ceiling (PRD §6.2)

export class TelegramError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    public readonly description: string,
    public readonly retryable: boolean,
    public readonly retryAfterSec?: number,
  ) {
    super(`Telegram ${method} ${status}: ${description}`);
  }
  get notModified() {
    return /message is not modified/i.test(this.description);
  }
  get messageGone() {
    return /message to edit not found|message can't be edited/i.test(this.description);
  }
  get fileTooBig() {
    return /file is too big/i.test(this.description);
  }
}

interface CallOptions {
  timeoutMs?: number;
}

export function createTelegram(token: string, deps: Pick<Deps, 'fetch'>) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call<T>(method: string, body: BodyInit, headers: HeadersInit, opts: CallOptions = {}): Promise<T> {
    let res: Response;
    try {
      res = await deps.fetch(`${base}/${method}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new TelegramError(method, 0, e instanceof Error ? e.message : String(e), true);
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (res.ok && data.ok) return data.result as T;
    const status = res.status;
    throw new TelegramError(
      method,
      status,
      data.description ?? `HTTP ${status}`,
      status === 429 || status >= 500,
      data.parameters?.retry_after,
    );
  }

  const json = <T>(method: string, payload: unknown, opts?: CallOptions) =>
    call<T>(method, JSON.stringify(payload), { 'content-type': 'application/json' }, opts);

  const replyTo = (messageId?: number) =>
    messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {};

  return {
    /** Returns the sent message's ID. Plain text only (FR-033). */
    async sendMessage(chatId: number, text: string, replyToId?: number, opts?: CallOptions): Promise<number> {
      const r = await json<{ message_id: number }>(
        'sendMessage',
        { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...replyTo(replyToId) },
        opts,
      );
      return r.message_id;
    },

    /** "Message is not modified" counts as success: the text is already there. */
    async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
      try {
        await json('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text,
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        if (e instanceof TelegramError && e.notModified) return;
        throw e;
      }
    },

    async sendDocument(chatId: number, filename: string, content: string, replyToId?: number): Promise<number> {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('document', new File([content], filename, { type: 'text/markdown' }));
      if (replyToId) {
        form.append('reply_parameters', JSON.stringify({ message_id: replyToId, allow_sending_without_reply: true }));
      }
      const r = await call<{ message_id: number }>('sendDocument', form, {}, { timeoutMs: 30_000 });
      return r.message_id;
    },

    async getFile(fileId: string): Promise<{ file_path: string; file_size?: number }> {
      const r = await json<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
      if (!r.file_path) throw new TelegramError('getFile', 200, 'no file_path in response', true);
      return { file_path: r.file_path, file_size: r.file_size };
    },

    async downloadFile(filePath: string): Promise<ArrayBuffer> {
      let res: Response;
      try {
        res = await deps.fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        throw new TelegramError('downloadFile', 0, e instanceof Error ? e.message : String(e), true);
      }
      if (!res.ok) throw new TelegramError('downloadFile', res.status, `HTTP ${res.status}`, res.status >= 500 || res.status === 429);
      return res.arrayBuffer();
    },
  };
}

export type Telegram = ReturnType<typeof createTelegram>;
