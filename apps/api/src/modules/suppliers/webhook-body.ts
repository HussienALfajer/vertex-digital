import type { IncomingMessage, ServerResponse } from 'node:http';

/** The supplier webhook's route (S08 rule F4) and its body limit (64 KB, as nginx enforces). */
export const SUPPLIER_WEBHOOK_ROUTE = '/api/webhooks/suppliers/:code';
const MAX_BYTES = 64 * 1024;

/**
 * Reads a supplier webhook's raw body before Nest's JSON parser, which would change the bytes the
 * signature covers: the route gets `request.body` as a `Buffer`. Over 64 KB, by its
 * `Content-Length` or as it arrives: 413, no body.
 */
export function supplierWebhookBody(
  request: IncomingMessage & { body?: unknown; _body?: boolean },
  response: ServerResponse,
  next: () => void,
): void {
  if (Number(request.headers['content-length'] ?? 0) > MAX_BYTES) {
    response.writeHead(413).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BYTES) {
      refused = true;
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (refused) return;
    request.body = Buffer.concat(chunks);
    // Tells the body parsers that the body was read.
    request._body = true;
    next();
  });
}
