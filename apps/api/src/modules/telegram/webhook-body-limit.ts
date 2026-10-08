import type { IncomingMessage, ServerResponse } from 'node:http';

/** The webhook's path and its body limit (S05: 64 KB, as nginx enforces in production). */
export const TELEGRAM_WEBHOOK_PATH = '/api/webhooks/telegram';
const MAX_BYTES = 64 * 1024;

/**
 * Refuses a webhook body over 64 KB before the JSON parser reads it (413, no body). Telegram
 * always sends `Content-Length`; a request without it is refused too (411).
 */
export function telegramWebhookBodyLimit(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const length = request.headers['content-length'];
  if (length === undefined) {
    response.writeHead(411).end();
    return;
  }
  if (Number(length) > MAX_BYTES) {
    response.writeHead(413).end();
    return;
  }
  next();
}
