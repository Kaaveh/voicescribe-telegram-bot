import type { Deps } from './deps';

export class HttpError extends Error {
  constructor(
    public readonly status: number, // 0 = network error or timeout
    public readonly body: string,
    public readonly retryable: boolean,
  ) {
    super(status ? `HTTP ${status}: ${body.slice(0, 300)}` : `network: ${body.slice(0, 300)}`);
  }
}

export interface RetryPolicy {
  timeoutMs: number;
  attempts: number;
  baseDelayMs: number;
}

/** FR-028 default: explicit timeout, backoff on 5xx/429/network, max 3 attempts. */
export const DEFAULT_RETRY: RetryPolicy = { timeoutMs: 60_000, attempts: 3, baseDelayMs: 2_000 };

/**
 * Fetch with timeout and exponential backoff. Retries 429, 5xx, network errors
 * and timeouts; any other non-2xx throws immediately as non-retryable.
 */
export async function fetchWithRetry(
  deps: Pick<Deps, 'fetch' | 'sleep'>,
  url: string,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<Response> {
  let last: HttpError = new HttpError(0, 'no attempt made', true);
  for (let i = 0; i < policy.attempts; i++) {
    if (i > 0) await deps.sleep(policy.baseDelayMs * 2 ** (i - 1));
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(policy.timeoutMs) });
    } catch (e) {
      last = new HttpError(0, e instanceof Error ? e.message : String(e), true);
      continue;
    }
    if (res.ok) return res;
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    last = new HttpError(res.status, body, retryable);
    if (!retryable) throw last;
  }
  throw last;
}
