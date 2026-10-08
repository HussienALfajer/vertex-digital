import {
  QUEUES,
  TELEGRAM_MESSAGE_PARAMS,
  type TelegramMessageKind,
  type TelegramMessageParams,
} from '@vertex-digital/contracts';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import type { JobSender } from '../notifications/index.js';
import { telegramMessages } from '../schema/index.js';

/** Five retries from 10 seconds, doubling (S05 `telegram.send`); a 429 waits its `retry_after`. */
export const TELEGRAM_SEND_OPTIONS = { retryLimit: 5, retryDelay: 10, retryBackoff: true };

export interface TelegramMessageInput<Kind extends TelegramMessageKind> {
  kind: Kind;
  params: TelegramMessageParams<Kind>;
  /** A second message with the same key is not written (`switch:<changeId>`). */
  dedupeKey?: string;
  /** A chat other than the live link's (rule TG3); by default the live link at send time. */
  chatId?: number;
}

/**
 * The bot's outbox (S05 F07, ADR 0019): a `telegram_messages` row and its `telegram.send` job,
 * written in the caller's transaction, so a message exists only if the change that causes it
 * commits. The API never calls Telegram; the worker sends. Returns the row id, or null when the
 * dedupe key was already used.
 */
export async function queueTelegramMessage<Kind extends TelegramMessageKind>(
  tx: Transaction,
  jobs: JobSender,
  message: TelegramMessageInput<Kind>,
): Promise<string | null> {
  const [row] = await tx
    .insert(telegramMessages)
    .values({
      id: newId(),
      kind: message.kind,
      params: TELEGRAM_MESSAGE_PARAMS[message.kind].parse(message.params),
      dedupeKey: message.dedupeKey ?? null,
      chatId: message.chatId ?? null,
    })
    .onConflictDoNothing({ target: telegramMessages.dedupeKey })
    .returning({ id: telegramMessages.id });
  if (!row) return null;
  await jobs.send(tx, QUEUES.telegramSend, { messageId: row.id }, TELEGRAM_SEND_OPTIONS);
  return row.id;
}
