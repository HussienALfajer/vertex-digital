import type { FailureKind } from '@vertex-digital/contracts';
import type { z } from 'zod';
import { SupplierError } from './errors.js';

export interface SupplierHttpOptions {
  baseUrl: string;
  /** Injected so tests and the fake server replace the network; defaults to the global one. */
  fetch?: typeof fetch;
  /** Per request; a supplier that does not answer in time is a retryable error. */
  timeoutMs?: number;
  /** Sent on every request (authentication). Never logged. */
  headers?: Record<string, string>;
}

export interface SupplierRequest<T> {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Every successful reply is parsed: an unexpected shape is an error, never trusted. */
  schema: z.ZodType<T>;
  /**
   * Reads the supplier's error code from a refused reply's body, for the error mapping. A refusal
   * is definitive only when `definitiveCodes` lists its code: an unmapped refusal may hide a
   * purchase (a repeated idempotency key, a proxy error), so it stays retryable (ADR 0004).
   */
  errorCode?: (body: unknown) => string | undefined;
  definitiveCodes?: string[];
  /** Overrides the client's timeout for this request (a purchase may take longer). */
  timeoutMs?: number;
}

/** A successful reply with its status and headers, for suppliers that answer through them. */
export interface SupplierReply<T> {
  status: number;
  headers: Headers;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Statuses whose `location` names where to read instead; at most a few, on the same origin. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
/** Timeout, conflict (a request with the same key in progress), too early, too many requests. */
const ALWAYS_RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

/** Node's and undici's error codes, by what failed (S18 FK1). */
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ENODATA']);
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);
const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/;

/** The first `code` along an error's causes (undici wraps the socket's error). */
function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}

/** S18 FK1: why a request got no reply at all. */
export function networkFailure(error: unknown): FailureKind {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  const code = errorCodeOf(error);
  if (code === undefined) return 'other';
  if (DNS_CODES.has(code)) return 'dns';
  if (TLS_CODE.test(code)) return 'tls';
  if (CONNECT_CODES.has(code)) return 'connect';
  return 'other';
}

/** S18 FK1: what a refused reply's status says. */
function statusFailure(status: number): FailureKind {
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

/**
 * When a rate limit lifts, from `x-ratelimit-reset` (Unix seconds) or `retry-after` (seconds),
 * as epoch milliseconds; undefined without either.
 */
function retryAtOf(headers: Headers, now: number): number | undefined {
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && /^\d{1,12}$/.test(reset)) return Number(reset) * 1000;
  const after = headers.get('retry-after');
  if (after !== null && /^\d{1,6}$/.test(after)) return now + Number(after) * 1000;
  return undefined;
}

/** JSON over HTTP for one supplier, with timeouts, parsing and error classification. */
export class SupplierHttp {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: SupplierHttpOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  async request<T>(request: SupplierRequest<T>): Promise<T> {
    return (await this.send(request)).data;
  }

  /** As `request`, with the reply's status and headers (polling by status, rate-limit headers). */
  async send<T>(request: SupplierRequest<T>): Promise<SupplierReply<T>> {
    const signal = AbortSignal.timeout(
      request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    let target = new URL(request.path, this.options.baseUrl);
    let response: Response;
    // Redirects are followed by hand: `fetch` would carry the credential headers (`x-api-key` is
    // no `authorization`) to whatever host a redirect names. Only a read, only on the same origin.
    for (let hops = 0; ; hops += 1) {
      try {
        response = await this.fetchFn(target, {
          method: request.method,
          headers: {
            accept: 'application/json',
            ...(request.body !== undefined && { 'content-type': 'application/json' }),
            ...this.options.headers,
            ...request.headers,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: 'manual',
          signal,
        });
      } catch (cause) {
        const failure = networkFailure(cause);
        throw new SupplierError(
          'retryable',
          failure === 'timeout' ? 'Supplier timed out' : `Supplier unreachable (${failure})`,
          { failure, cause },
        );
      }
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get('location')
        : null;
      if (location === null) break;
      const next = new URL(location, target);
      if (request.method !== 'GET' || next.origin !== target.origin || hops >= MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined);
        // An order sent and redirected may have been placed: retryable, so its outcome is unknown.
        throw new SupplierError('retryable', `Supplier redirected (HTTP ${response.status})`, {
          status: response.status,
          failure: 'redirect',
        });
      }
      await response.body?.cancel().catch(() => undefined);
      target = next;
    }

    const text = await response.text().catch(() => '');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const supplierCode = request.errorCode?.(body);
      const definitive =
        response.status < 500 &&
        !ALWAYS_RETRYABLE_STATUSES.has(response.status) &&
        supplierCode !== undefined &&
        (request.definitiveCodes ?? []).includes(supplierCode);
      const retryAt = response.status === 429 ? retryAtOf(response.headers, Date.now()) : undefined;
      throw new SupplierError(
        definitive ? 'definitive' : 'retryable',
        `Supplier answered HTTP ${response.status}${supplierCode ? ` (${supplierCode})` : ''}`,
        {
          status: response.status,
          failure: statusFailure(response.status),
          ...(supplierCode !== undefined && { supplierCode }),
          ...(retryAt !== undefined && { retryAt }),
        },
      );
    }

    const parsed = request.schema.safeParse(body);
    if (!parsed.success) {
      throw new SupplierError('retryable', 'Supplier reply has an unexpected shape', {
        status: response.status,
        failure: 'unreadable',
        cause: parsed.error,
      });
    }
    return { status: response.status, headers: response.headers, data: parsed.data };
  }
}
