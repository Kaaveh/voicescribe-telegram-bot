// Delivery formatting (FR-025, FR-032, FR-033; PRD §13 decision 2). Pure: no I/O.
import { NO_SPEECH, RAW_MARKER } from './messages';
import type { ValidationResult } from './validate';

/** Telegram's limit is 4096; above this a transcript goes out as a .md document (FR-032). */
export const MESSAGE_LIMIT = 4000;

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * ASCII and Arabic-Indic digits → Persian digits, except inside Latin tokens
 * such as "MP3" or "v2", which stay as written (mixed-language rule, PRD §4).
 */
export function toPersianDigits(text: string): string {
  return text.replace(/(?<![A-Za-z])[0-9٠-٩]+(?![A-Za-z])/g, (run) =>
    [...run].map((d) => PERSIAN_DIGITS[d.charCodeAt(0) >= 0x0660 ? d.charCodeAt(0) - 0x0660 : Number(d)]).join(''),
  );
}

/** Orthography-only fixes allowed on raw fallback text (art. II): Arabic ي/ك → Persian ی/ک. */
export function fixLetterVariants(text: string): string {
  return text.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
}

export type Delivery = { kind: 'text'; text: string } | { kind: 'document'; text: string; filename: string };

export interface FormatInput {
  raw: string;
  clean: string;
  validation: ValidationResult;
  numeralStyle: string;
  jobId: string;
}

/** Plain text only — never MarkdownV2 — so no escaping is needed (FR-033). */
export function formatDelivery({ raw, clean, validation, numeralStyle, jobId }: FormatInput): Delivery {
  if (raw.trim() === '' && clean.trim() === '') return { kind: 'text', text: NO_SPEECH };
  let body = validation.ok ? clean.trim() : `${RAW_MARKER}\n\n${fixLetterVariants(raw.trim())}`;
  if (numeralStyle === 'persian') body = toPersianDigits(body);
  if (body.length > MESSAGE_LIMIT) {
    return { kind: 'document', text: body, filename: `transcript-${jobId.slice(0, 8)}.md` };
  }
  return { kind: 'text', text: body };
}
