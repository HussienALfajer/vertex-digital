import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  QUEUES,
  TELEGRAM_MESSAGE_PARAMS,
  type TelegramSendPayload,
  telegramSendPayloadSchema,
} from '@vertex-digital/contracts';
import {
  type Database,
  TELEGRAM_SEND_OPTIONS,
  type Transaction,
  telegramLinks,
  telegramMessages,
  transactionExecutor,
} from '@vertex-digital/db';
import { eq, isNull } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { TelegramApiError, TelegramBot } from '../../telegram/bot-api.js';
import { renderTelegramMessage } from '../../telegram/messages.js';

/** The first send and the five retries `queueTelegramMessage` asks for. */
export const MAX_TELEGRAM_ATTEMPTS = 6;

export type TelegramSendOutcome = 'sent' | 'skipped' | 'failed' | 'retry' | 'none';

/** A refusal no retry can change: the bot blocked by the admin (403), a malformed message (400). */
const FINAL_STATUSES = new Set([400, 403]);

/**
 * `telegram.send` (S05 F07): sends one `telegram_messages` row. Safe to run twice: the row is
 * locked and sent only while `pending`. With no chat to send to (no live link, the bot not
 * configured) the row is `skipped` (edge case 2). A `429` waits Telegram's `retry_after` through a
 * delayed job; a `403` (the admin blocked the bot) or `400` fails at once with a warning; other
 * failures are thrown for pg-boss to retry with backoff, and the last one leaves the row `failed`.
 * A crash between Telegram and the update can send one message twice: accepted, as for email.
 */
@Injectable()
export class SendTelegramJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SendTelegramJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly bot: TelegramBot,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<TelegramSendPayload>(QUEUES.telegramSend, async (data) => {
      await this.send(telegramSendPayloadSchema.parse(data).messageId);
    });
    this.logger.log(`Working ${QUEUES.telegramSend}`);
  }

  /** `db` lets a test run the job inside its own transaction (a savepoint). */
  async send(
    messageId: string,
    now = new Date(),
    db: Database | Transaction = this.db,
  ): Promise<TelegramSendOutcome> {
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(telegramMessages)
        .where(eq(telegramMessages.id, messageId))
        .for('update', { skipLocked: true });
      // Missing, being sent by another run, or already settled: nothing to do.
      if (row?.status !== 'pending') return { result: 'none' } as const;
      const chatId = row.chatId ?? (await this.liveChat(tx));
      if (!this.bot.configured || chatId === null) {
        await tx
          .update(telegramMessages)
          .set({ status: 'skipped' })
          .where(eq(telegramMessages.id, row.id));
        return { result: 'skipped' } as const;
      }
      const attempts = row.attempts + 1;
      try {
        const message = renderTelegramMessage(
          row.kind,
          TELEGRAM_MESSAGE_PARAMS[row.kind].parse(row.params) as never,
        );
        const sent = (await this.bot.call('sendMessage', {
          chat_id: chatId,
          text: message.text,
          ...(message.buttons && {
            reply_markup: {
              inline_keyboard: message.buttons.map((buttonRow) =>
                buttonRow.map((button) => ({ text: button.text, callback_data: button.data })),
              ),
            },
          }),
        })) as { message_id?: number } | undefined;
        await tx
          .update(telegramMessages)
          .set({
            attempts,
            status: 'sent',
            sentAt: now,
            lastError: null,
            telegramMessageId: sent?.message_id ?? null,
          })
          .where(eq(telegramMessages.id, row.id));
        return { result: 'sent' } as const;
      } catch (error) {
        const final = attempts >= MAX_TELEGRAM_ATTEMPTS;
        const refused = error instanceof TelegramApiError && FINAL_STATUSES.has(error.status);
        const failed = final || refused;
        await tx
          .update(telegramMessages)
          .set({
            attempts,
            status: failed ? 'failed' : 'pending',
            lastError: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 500),
          })
          .where(eq(telegramMessages.id, row.id));
        if (refused) {
          this.logger.warn(`Telegram refused message ${row.id}: ${(error as Error).message}`);
          return { result: 'failed' } as const;
        }
        if (failed) return { result: 'error', error } as const;
        if (error instanceof TelegramApiError && error.retryAfter !== undefined) {
          // Rule: a 429 waits its `retry_after`, longer than pg-boss's own backoff may be.
          await this.pgBoss.boss.send(
            QUEUES.telegramSend,
            { messageId: row.id },
            { ...TELEGRAM_SEND_OPTIONS, startAfter: error.retryAfter, db: transactionExecutor(tx) },
          );
          return { result: 'retry' } as const;
        }
        return { result: 'error', error } as const;
      }
    });
    if (outcome.result === 'error') throw outcome.error;
    return outcome.result;
  }

  private async liveChat(tx: Transaction): Promise<number | null> {
    const [link] = await tx
      .select({ chatId: telegramLinks.chatId })
      .from(telegramLinks)
      .where(isNull(telegramLinks.unlinkedAt));
    return link?.chatId ?? null;
  }
}
