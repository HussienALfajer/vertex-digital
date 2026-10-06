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
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Timeout, conflict (a request with the same key in progress), too early, too many requests. */
const ALWAYS_RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

/** JSON over HTTP for one supplier, with timeouts, parsing and error classification. */
export class SupplierHttp {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: SupplierHttpOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  async request<T>(request: SupplierRequest<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(new URL(request.path, this.options.baseUrl), {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...(request.body !== undefined && { 'content-type': 'application/json' }),
          ...this.options.headers,
          ...request.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
      throw new SupplierError(
        'retryable',
        timedOut ? 'Supplier timed out' : 'Supplier unreachable',
        {
          cause,
        },
      );
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
      throw new SupplierError(
        definitive ? 'definitive' : 'retryable',
        `Supplier answered HTTP ${response.status}${supplierCode ? ` (${supplierCode})` : ''}`,
        { status: response.status, ...(supplierCode !== undefined && { supplierCode }) },
      );
    }

    const parsed = request.schema.safeParse(body);
    if (!parsed.success) {
      throw new SupplierError('retryable', 'Supplier reply has an unexpected shape', {
        status: response.status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
