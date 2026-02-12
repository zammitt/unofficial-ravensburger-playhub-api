/**
 * Shared HTTP utilities: timeout + bounded retry for transient failures.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_BACKOFF_DELAY_MS = 5_000;
const MAX_SERVER_RETRY_DELAY_MS = 60_000;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_AFTER_STATUS_CODES = new Set([429, 503]);
const RETRYABLE_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

export interface FetchPolicy {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (RETRYABLE_ERROR_NAMES.has(error.name)) return true;
  if (error.message.includes("Request timed out")) return true;
  // Network/socket failures from fetch typically surface as TypeError.
  return error instanceof TypeError;
}

function clampDelay(ms: number, maxMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.min(ms, maxMs));
}

/**
 * Parse Retry-After header into milliseconds.
 * Supports seconds ("5") and HTTP-date values.
 */
export function parseRetryAfterMs(retryAfter: string | null, nowMs: number = Date.now()): number | null {
  if (!retryAfter) return null;
  const value = retryAfter.trim();
  if (!value) return null;

  if (/^[+-]?\d+(\.\d+)?$/.test(value)) {
    const asSeconds = Number.parseFloat(value);
    if (!Number.isFinite(asSeconds) || asSeconds < 0) {
      return null;
    }
    return clampDelay(Math.round(asSeconds * 1000), MAX_SERVER_RETRY_DELAY_MS);
  }

  const asDateMs = Date.parse(value);
  if (Number.isNaN(asDateMs)) {
    return null;
  }
  return clampDelay(asDateMs - nowMs, MAX_SERVER_RETRY_DELAY_MS);
}

/**
 * Exponential backoff with jitter.
 * Jitter is in the range [0.5x, 1.5x] of the exponential delay.
 */
export function getJitteredBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  random: number = Math.random()
): number {
  const safeBaseDelayMs = clampDelay(baseDelayMs, MAX_BACKOFF_DELAY_MS);
  if (safeBaseDelayMs === 0) return 0;
  const exponential = Math.min(safeBaseDelayMs * Math.pow(2, attempt), MAX_BACKOFF_DELAY_MS);
  const normalizedRandom = Math.max(0, Math.min(random, 1));
  const jitterMultiplier = 0.5 + normalizedRandom;
  return Math.round(Math.min(exponential * jitterMultiplier, MAX_BACKOFF_DELAY_MS));
}

function resolveRetryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  if (RETRY_AFTER_STATUS_CODES.has(response.status)) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs != null) return retryAfterMs;
  }
  return getJitteredBackoffDelayMs(attempt, baseDelayMs);
}

function createTimeoutSignal(timeoutMs: number, upstreamSignal?: AbortSignal | null): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onUpstreamAbort = () => controller.abort(upstreamSignal?.reason);

  if (upstreamSignal) {
    if (upstreamSignal.aborted) onUpstreamAbort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (upstreamSignal) {
        upstreamSignal.removeEventListener("abort", onUpstreamAbort);
      }
    },
  };
}

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  policy: FetchPolicy = {}
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = policy.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = policy.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { signal, cleanup } = createTimeoutSignal(timeoutMs, init.signal);
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.ok) {
        return response;
      }

      const shouldRetry = attempt < maxRetries && RETRYABLE_STATUS_CODES.has(response.status);
      if (!shouldRetry) {
        return response;
      }

      // Drain body before retry to avoid leaking sockets/resources.
      await response.arrayBuffer().catch(() => {});
      await sleep(resolveRetryDelayMs(response, attempt, retryDelayMs));
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < maxRetries && isRetryableError(error);
      if (!shouldRetry) {
        throw error;
      }
      await sleep(getJitteredBackoffDelayMs(attempt, retryDelayMs));
    } finally {
      cleanup();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries.");
}
