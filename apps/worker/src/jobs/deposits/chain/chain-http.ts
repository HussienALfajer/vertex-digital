import type { z } from 'zod';
import { ChainReaderError } from './chain-reader.js';

/** Every read gives up after 10 seconds; the job retries, the reader never does. */
export const CHAIN_TIMEOUT_MS = 10_000;

export interface ChainHttpConfig {
  /** Headers sent with every request (an API key). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * JSON over HTTPS for the readers: a timeout, then every reply parsed with Zod. Anything but a
 * parsed 2xx reply is a `ChainReaderError`, never an answer (rule U6). URLs are never put in
 * errors: a provider's key may be in them.
 */
export class ChainHttp {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: ChainHttpConfig = {}) {
    this.fetchFn = config.fetch ?? fetch;
  }

  async request<T>(
    url: string,
    schema: z.ZodType<T>,
    init: { method: 'GET' | 'POST'; body?: unknown; label: string },
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: init.method,
        headers: {
          accept: 'application/json',
          ...(init.body !== undefined && { 'content-type': 'application/json' }),
          ...this.config.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? CHAIN_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ChainReaderError('timeout', `${init.label} timed out`);
      }
      throw new ChainReaderError(
        'unavailable',
        `${init.label} failed: ${(error as Error).message}`,
      );
    }
    if (response.status === 429) {
      throw new ChainReaderError('rate_limited', `${init.label} was rate limited`);
    }
    if (!response.ok) {
      throw new ChainReaderError('unavailable', `${init.label} answered ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ChainReaderError('bad_response', `${init.label} answered no JSON`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ChainReaderError('bad_response', `${init.label} answered an unexpected shape`);
    }
    return parsed.data;
  }
}
