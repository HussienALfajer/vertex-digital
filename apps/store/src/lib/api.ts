import { ERROR_CODES, type ErrorCode } from '@vertex-digital/contracts';

/**
 * Why a request failed, as the screens explain it: an API error code (`errors.<code>`), no
 * connection, or anything else.
 */
export type Failure = ErrorCode | 'INVALID_EMAIL_OR_PASSWORD' | 'NETWORK' | 'UNKNOWN';

/**
 * A call's outcome. A refusal may carry the API's `details` (a deposit's limits, the offer of a
 * new rate): data for the screen, never text to show as it is.
 */
export type Result<Data> =
  | { ok: true; data: Data }
  | { ok: false; reason: Failure; details?: unknown };

/** Codes the API and Better Auth answer that are not API error codes but the store explains. */
const BETTER_AUTH_CODES = ['INVALID_EMAIL_OR_PASSWORD'] as const;

function failureOf(status: number, code: unknown): Failure {
  if (typeof code === 'string') {
    if ((ERROR_CODES as readonly string[]).includes(code)) return code as ErrorCode;
    if ((BETTER_AUTH_CODES as readonly string[]).includes(code)) return code as Failure;
  }
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'UNAUTHORIZED';
  return 'UNKNOWN';
}

/**
 * A same-origin call to the API (`/api/...`; nginx in production, a rewrite in development). The
 * customer session cookie goes with it. A `FormData` body is sent as multipart (a receipt); any
 * other body as JSON. Never throws: the result says what went wrong by code, so the screen shows
 * its translation, never the server's message.
 */
export async function apiRequest<Data = unknown>(
  path: string,
  {
    method = 'GET',
    body,
    headers,
    fetcher = fetch,
  }: {
    method?: 'GET' | 'POST' | 'PATCH';
    body?: unknown;
    headers?: Record<string, string>;
    fetcher?: typeof fetch;
  } = {},
): Promise<Result<Data>> {
  let response: Response;
  const json = body !== undefined && !(body instanceof FormData);
  try {
    response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: json ? { 'content-type': 'application/json', ...headers } : headers,
      body: json ? JSON.stringify(body) : (body as FormData | undefined),
    });
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
  const data: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: data as Data };
  const error = data as { code?: unknown; details?: unknown } | null;
  const reason = failureOf(response.status, error?.code);
  return error?.details === undefined
    ? { ok: false, reason }
    : { ok: false, reason, details: error.details };
}
