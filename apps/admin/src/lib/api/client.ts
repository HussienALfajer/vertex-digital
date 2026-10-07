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

/** Resolves to the response body, or throws `ApiError`. */
export async function call<Data>(
  request: Promise<{ data?: Data; error?: unknown; response: Response }>,
): Promise<Data> {
  const { data, error, response } = await request;
  if (!response.ok) {
    const body = (error ?? {}) as Partial<ErrorResponse>;
    throw new ApiError(
      response.status,
      body.code,
      body.details,
      body.message ?? `HTTP ${response.status}`,
    );
  }
  return data as Data;
}
