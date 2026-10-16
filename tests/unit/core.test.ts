import { describe, expect, it } from 'vitest';
import { classify, secretsEqual, type TelegramUpdate } from '../../src/core/authorize';
import { MESSAGE_LIMIT, fixLetterVariants, formatDelivery, toPersianDigits } from '../../src/core/format';
import { NO_SPEECH, RAW_MARKER } from '../../src/core/messages';
import { hasNgramLoop, parseBounds, validate } from '../../src/core/validate';

const OWNER = '1001';
const msg = (over: Record<string, unknown> = {}): TelegramUpdate => ({
  update_id: 1,
  message: { message_id: 10, date: 0, from: { id: 1001, username: 'owner' }, chat: { id: 1001, type: 'private' }, ...over },
});

describe('classify (FR-001/002/005/010/012/013)', () => {
  it('accepts owner voice, forwarded or not, ignoring captions', () => {
    const v = { file_id: 'f', file_unique_id: 'u', duration: 3 };
    expect(classify(msg({ voice: v }), OWNER).kind).toBe('voice');
    expect(classify(msg({ voice: v, caption: 'hi', forward_origin: { type: 'hidden_user' } }), OWNER).kind).toBe('voice');
  });
  it('rejects other users, even with the owner username', () => {
    const u = msg({ from: { id: 2002, username: 'owner' } });
    expect(classify(u, OWNER)).toEqual({ kind: 'unauthorized', fromId: 2002 });
  });
  it('rejects the owner outside a private chat', () => {
    expect(classify(msg({ chat: { id: -5, type: 'group' } }), OWNER).kind).toBe('unauthorized');
  });
  it('rejects messages without a sender', () => {
    expect(classify(msg({ from: undefined }), OWNER)).toEqual({ kind: 'unauthorized', fromId: null });
  });
  it('routes /start, /help and /help@bot to help; other input to voice-only', () => {
    expect(classify(msg({ text: '/start' }), OWNER).kind).toBe('help');
    expect(classify(msg({ text: '/help@my_bot' }), OWNER).kind).toBe('help');
    expect(classify(msg({ text: 'hello' }), OWNER).kind).toBe('other');
    expect(classify(msg({ photo: [{}] }), OWNER).kind).toBe('other');
  });
  it('ignores non-message updates', () => {
    expect(classify({ update_id: 1 }, OWNER).kind).toBe('ignore');
  });
});

describe('secretsEqual (FR-003)', () => {
  it('compares exactly, including different lengths', async () => {
    expect(await secretsEqual('abc', 'abc')).toBe(true);
    expect(await secretsEqual('abc', 'abd')).toBe(false);
    expect(await secretsEqual('abc', 'abcd')).toBe(false);
    expect(await secretsEqual('', 'x')).toBe(false);
  });
});

describe('validate (FR-026/027)', () => {
  const bounds = parseBounds('0.6', '1.4');
  it('passes a faithful reformat', () => {
    const r = validate('سلام امروز هوا خوب است', 'سلام. امروز هوا خوب است.', bounds);
    expect(r).toMatchObject({ ok: true, failures: [] });
  });
  it('catches silent summarization with the length guard', () => {
    const raw = 'کلمه '.repeat(100);
    expect(validate(raw, 'خلاصه.', bounds).failures).toContain('LENGTH_GUARD');
  });
  it('catches Arabic ي/ك with the script guard', () => {
    expect(validate('كتاب', 'كتاب', bounds).failures).toEqual(['SCRIPT_GUARD']);
    expect(validate('يک', 'يک', bounds).failures).toEqual(['SCRIPT_GUARD']);
  });
  it('catches repetition loops', () => {
    expect(hasNgramLoop('یک دو سه یک دو سه یک دو سه یک دو سه')).toBe(true);
    expect(hasNgramLoop('یک دو سه چهار پنج شش')).toBe(false);
    expect(validate('a', 'یک دو سه '.repeat(4), { min: 0, max: 1e9 }).failures).toEqual(['NGRAM_LOOP']);
  });
  it('rejects nonsensical bounds', () => {
    expect(() => parseBounds('1.4', '0.6')).toThrow();
    expect(() => parseBounds('x', '1')).toThrow();
  });
});

describe('format (FR-025/032/033)', () => {
  const ok = { ok: true, failures: [], lengthRatio: 1 };
  const bad = { ok: false, failures: ['SCRIPT_GUARD'], lengthRatio: 1 };
  it('converts digits to Persian except inside Latin tokens', () => {
    expect(toPersianDigits('ساعت 10 و ٣ دقیقه با MP3 و v2')).toBe('ساعت ۱۰ و ۳ دقیقه با MP3 و v2');
  });
  it('fixes letter variants', () => {
    expect(fixLetterVariants('كتاب علي')).toBe('کتاب علی');
  });
  it('delivers clean text when validation passes', () => {
    const d = formatDelivery({ raw: 'r', clean: ' ساعت 5. ', validation: ok, numeralStyle: 'persian', jobId: 'abc' });
    expect(d).toEqual({ kind: 'text', text: 'ساعت ۵.' });
  });
  it('falls back to marked, orthography-fixed raw text when validation fails', () => {
    const d = formatDelivery({ raw: 'كتاب', clean: 'x', validation: bad, numeralStyle: 'persian', jobId: 'abc' });
    expect(d).toEqual({ kind: 'text', text: `${RAW_MARKER}\n\nکتاب` });
  });
  it('reports no speech for empty transcripts', () => {
    expect(formatDelivery({ raw: ' ', clean: '', validation: ok, numeralStyle: 'persian', jobId: 'a' })).toEqual({ kind: 'text', text: NO_SPEECH });
  });
  it('switches to a document above the message limit', () => {
    const long = 'آ'.repeat(MESSAGE_LIMIT + 1);
    const d = formatDelivery({ raw: long, clean: long, validation: ok, numeralStyle: 'latin', jobId: '12345678-abcd' });
    expect(d).toEqual({ kind: 'document', text: long, filename: 'transcript-12345678.md' });
  });
});

describe('/retry parsing (FR-042)', () => {
  const id = '6f1c2a9e-1b2c-4d3e-8f90-0a1b2c3d4e5f';
  it('takes the ID from the command or from the replied-to failure notice', () => {
    expect(classify(msg({ text: `/retry ${id.toUpperCase()}` }), OWNER)).toMatchObject({ kind: 'retry', jobId: id });
    expect(classify(msg({ text: '/retry', reply_to_message: { message_id: 3, text: `خطا\nکد پیگیری: ${id}` } }), OWNER)).toMatchObject({
      kind: 'retry',
      jobId: id,
    });
    expect(classify(msg({ text: '/retry' }), OWNER)).toMatchObject({ kind: 'retry', jobId: null });
  });
});
