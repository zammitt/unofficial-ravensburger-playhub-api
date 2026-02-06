/**
 * Fetch with timeout and retries for external HTTP calls.
 * Retries on timeout, network errors, and 5xx/429 responses with exponential backoff.
 */

export interface FetchWithRetryOptions extends Omit<RequestInit, 'signal'> {
  /** Request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** Max retry attempts (excluding initial request). Default 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default 1000. */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEBUG_FETCH_RETRY = /^(1|true|yes|on)$/i.test(process.env.PLAYHUB_API_DEBUG ?? '');

/** Status codes we retry (transient errors) */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function isRetryableError(err: unknown): boolean {
  if (err instanceof TypeError && err.message?.includes('fetch')) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logRetry(payload: Record<string, unknown>): void {
  if (!DEBUG_FETCH_RETRY) return;
  console.warn({ event: 'fetch_retry', ...payload });
}

/**
 * Fetch with timeout and retries.
 * Uses AbortController for timeout. Retries on timeout, network errors, and 429/5xx with exponential backoff.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    ...init
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) return res;
      const shouldRetry = attempt < maxRetries && RETRYABLE_STATUS.has(res.status);
      if (shouldRetry) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        logRetry({
          url,
          status: res.status,
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = retryDelayMs * Math.pow(2, attempt);
        logRetry({
          url,
          error: err instanceof Error ? err.message : String(err),
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}
