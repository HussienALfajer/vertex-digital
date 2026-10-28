import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The response header that names a request, as its log line and Sentry event do. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * pino-http's `genReqId`: a UUID per request, answered in `X-Request-Id`, so an error a customer
 * or the admin reports can be found in the logs and Sentry (audit A10-37; pino's default was a
 * counter that started again at each restart).
 */
export function requestId(_request: IncomingMessage, response: ServerResponse): string {
  const id = randomUUID();
  response.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
