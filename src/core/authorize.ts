// Update classification (Constitution art. I). Pure: no I/O.

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  from?: { id: number; is_bot?: boolean; username?: string };
  chat: { id: number; type: string };
  text?: string;
  caption?: string; // ignored (FR-017)
  voice?: TelegramVoice;
  reply_to_message?: { message_id: number; text?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export type Classified =
  | { kind: 'ignore' } // not a message update
  | { kind: 'unauthorized'; fromId: number | null } // FR-005: silence
  | { kind: 'help'; message: TelegramMessage } // FR-013
  | { kind: 'voice'; message: TelegramMessage & { voice: TelegramVoice } } // FR-010/011
  | { kind: 'retry'; message: TelegramMessage; jobId: string | null } // FR-042
  | { kind: 'other'; message: TelegramMessage }; // FR-012

/**
 * Authorizes by numeric user ID only, never username (FR-001/002), and only in
 * a private chat (PRD §13 decision 4). Runs before anything else looks at the
 * message, so unauthorized traffic reaches no other logic.
 */
export function classify(update: TelegramUpdate, ownerId: string): Classified {
  const message = update.message;
  if (!message) return { kind: 'ignore' };
  const fromId = message.from?.id ?? null;
  if (fromId === null || String(fromId) !== ownerId.trim() || message.chat.type !== 'private') {
    return { kind: 'unauthorized', fromId };
  }
  if (message.voice) return { kind: 'voice', message: message as TelegramMessage & { voice: TelegramVoice } };
  const command = message.text?.trim().split(/[\s@]/, 1)[0];
  if (command === '/start' || command === '/help') return { kind: 'help', message };
  if (command === '/retry') {
    // "/retry <id>", or "/retry" sent as a reply to the failure notice that carries the ID.
    const jobId = findJobId(message.text ?? '') ?? findJobId(message.reply_to_message?.text ?? '');
    return { kind: 'retry', message, jobId };
  }
  return { kind: 'other', message };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function findJobId(text: string): string | null {
  return text.match(UUID)?.[0].toLowerCase() ?? null;
}

/** Constant-time string comparison (FR-003): hashes both sides to equal length first. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
