import { ERROR_CODES, type ErrorCode, type ErrorResponse } from '@vertex-digital/contracts';
import createClient from 'openapi-fetch';
import type { paths } from './schema.gen';

/**
 * The API client, typed from the OpenAPI document the API generates (ADR 0002). After an API
 * change: `pnpm --filter @vertex-digital/api openapi:export`, then
 * `pnpm --filter @vertex-digital/admin api:generate`. Better Auth endpoints (/api/admin/auth)
 * go through `authClient` instead. Paths are relative: the API is on the panel's own origin.
 */
export const api = createClient<paths>();

/**
 * Sent with the reads the panel makes on its own (the navigation badge, the stale-rate banner):
 * they do not count as the admin's activity for the 30-minute idle timeout (rule D4).
 */
export const BACKGROUND_REQUEST = { 'X-Background-Request': '1' } as const;

/** A failed API call, with the error code the UI translates (`errors.<code>`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly details: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The code when it is one of the API's own, so the UI can react to it. */
  get knownCode(): ErrorCode | undefined {
    return (ERROR_CODES as readonly string[]).includes(this.code ?? '')
      ? (this.code as ErrorCode)
      : undefined;
  }
}

/**
 * Resolves to the response body, or throws `ApiError`. A 413 without an API code is nginx's own
 * page for a body over its limit (an image above 6 MB, F7-3): it reads as the API's
 * `PAYLOAD_TOO_LARGE`, so the admin sees the size limit instead of an unexpected error.
 */
export async function call<Data>(
  request: Promise<{ data?: Data; error?: unknown; response: Response }>,
): Promise<Data> {
  const { data, error, response } = await request;
  if (!response.ok) {
    const body = (
      typeof error === 'object' && error !== null ? error : {}
    ) as Partial<ErrorResponse>;
    throw new ApiError(
      response.status,
      body.code ?? (response.status === 413 ? 'PAYLOAD_TOO_LARGE' : undefined),
      body.details,
      body.message ?? `HTTP ${response.status}`,
    );
  }
  return data as Data;
}
