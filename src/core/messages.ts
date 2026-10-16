// All user-facing copy is Persian (FR-035). Correlation IDs stay ASCII.

export const PLACEHOLDER = '⏳ در حال رونویسی…';

export const HELP =
  'سلام! این ربات پیام‌های صوتی فارسی را به متنی تمیز و خوانا تبدیل می‌کند. ' +
  'کافی است یک پیام صوتی بفرستید یا فوروارد کنید تا متن آن را همین‌جا، ' +
  'با نقطه‌گذاری و پاراگراف‌بندی درست، دریافت کنید. اگر رونویسی‌ای ناموفق بود، ' +
  'روی پیام خطا ریپلای کنید و /retry بفرستید.';

export const VOICE_ONLY = 'فعلاً فقط پیام‌های صوتی پشتیبانی می‌شوند. لطفاً یک پیام صوتی بفرستید یا فوروارد کنید.';

export const DOCUMENT_POINTER = 'متن کامل به‌صورت فایل پیوست شد ⬇';

export const RAW_MARKER = '⚠️ متن خام — قالب‌بندی در بررسی خودکار تأیید نشد:';

export const NO_SPEECH = 'در این پیام صوتی گفتاری تشخیص داده نشد.';

export const RETRY_QUEUED = '⏳ دوباره در صف رونویسی قرار گرفت.';

export const RETRY_NOT_FOUND =
  'پیام ناموفقی با این کد پیدا نشد. روی پیام خطا ریپلای کنید و /retry بفرستید، یا کد پیگیری را بعد از /retry بنویسید.';

export function fileTooLarge(correlationId: string): string {
  return `این فایل صوتی از سقف ۲۰ مگابایتی تلگرام برای ربات‌ها بزرگ‌تر است و قابل دریافت نیست.\nکد پیگیری: ${correlationId}`;
}

export function failed(correlationId: string): string {
  return `متأسفانه رونویسی انجام نشد. برای تلاش دوباره، روی همین پیام ریپلای کنید و /retry بفرستید.\nکد پیگیری: ${correlationId}`;
}
