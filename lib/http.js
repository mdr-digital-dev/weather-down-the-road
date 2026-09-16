/**
 * fetch with timeout, bounded retries on transient failures, and typed errors
 * so route handlers can map upstream problems to sensible HTTP responses.
 */

export class UpstreamError extends Error {
  constructor(message, { status = 502, service = 'upstream', retryable = false, cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.service = service;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export class BadRequest extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BadRequest';
    this.status = 400;
    if (details) this.details = details;
  }
}

const USER_AGENT = process.env.USER_AGENT || 'weather-down-the-road/2.0';

export async function fetchJson(url, {
  service = 'upstream',
  timeoutMs = 10_000,
  retries = 2,
  headers = {},
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      });
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        lastErr = new UpstreamError(`${service} returned ${res.status}`, {
          status: res.status === 429 ? 429 : 502,
          service,
          retryable: true,
        });
        if (attempt < retries) {
          await sleep(300 * 2 ** attempt + Math.random() * 200);
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch { /* ignore */ }
        throw new UpstreamError(`${service} returned ${res.status}: ${body.slice(0, 200)}`, {
          status: 502,
          service,
          retryable: false,
        });
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof UpstreamError) {
        if (!err.retryable || attempt >= retries) throw err;
        lastErr = err;
        continue;
      }
      const isAbort = err.name === 'AbortError';
      lastErr = new UpstreamError(
        isAbort ? `${service} timed out after ${timeoutMs}ms` : `${service} unreachable: ${err.message}`,
        { status: 504, service, retryable: true, cause: err },
      );
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt + Math.random() * 200);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async tasks with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
