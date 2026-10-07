import { ERROR_CODES, type ErrorCode } from '@vertex-digital/contracts';

/**
 * Why a request failed, as the screens explain it: an API error code (`errors.<code>`), no
 * connection, or anything else.
 */
export type Failure = ErrorCode | 'INVALID_EMAIL_OR_PASSWORD' | 'NETWORK' | 'UNKNOWN';

export type Result<Data> = { ok: true; data: Data } | { ok: false; reason: Failure };

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
 * customer session cookie goes with it. Never throws: the result says what went wrong by code, so
 * the screen shows its translation, never the server's message.
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
  try {
    response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
  const data: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: data as Data };
  return { ok: false, reason: failureOf(response.status, (data as { code?: unknown })?.code) };
}
