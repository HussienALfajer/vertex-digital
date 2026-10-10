import { readFile } from 'node:fs/promises';
import path, { isAbsolute, type PlatformPath, resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  QUEUES,
  rateFromNumeric,
  type TelegramDepositCardPayload,
  telegramApprovalRefusal,
  telegramDepositCardPayloadSchema,
} from '@vertex-digital/contracts';
import {
  customers,
  type Database,
  depositFlags,
  depositReceipts,
  depositSettings,
  deposits,
  storedFiles,
  type Transaction,
  telegramDepositCards,
  telegramLinks,
  telegramPrompts,
  usdtDeposits,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, count, desc, eq, isNull, ne } from 'drizzle-orm';
import sharp from 'sharp';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { TelegramApiError, TelegramBot } from '../../telegram/bot-api.js';
import {
  type DepositCardView,
  type RenderedTelegramMessage,
  renderDepositCard,
} from '../../telegram/messages.js';

export type DepositCardOutcome = 'sent' | 'edited' | 'skipped' | 'failed' | 'none';

type DepositRow = typeof deposits.$inferSelect;

/** The edit Telegram refuses because the card already shows it: a second run's edit. */
const NOT_MODIFIED = /message is not modified/i;

/** Refusals no retry can change: the bot blocked (403), a message gone or malformed (400). */
const FINAL_STATUSES = new Set([400, 403]);

/**
 * `telegram.deposit-card` (S05 rules TC1–TC6), one job per deposit at a time (`stately`): loads
 * the deposit fresh, then sends the card of its current submission while it waits (a Sham Cash
 * receipt as a JPEG photo, a USDT review as text), or edits that card to the outcome and removes
 * its buttons. Safe twice: a card is one row per `(deposit, submission)`, sent once, and an edit
 * that changes nothing is accepted. With no live link nothing is sent and later decisions edit
 * nothing (edge case 2). A crash between Telegram and the insert can send one card twice: accepted,
 * as for messages.
 */
@Injectable()
export class DepositCardJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(DepositCardJob.name);
  private readonly filesRoot: string;
  private readonly adminUrl: string;

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly bot: TelegramBot,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
  ) {
    // A relative root is the API's: it runs in `apps/api`, the worker in `apps/worker`.
    this.filesRoot = isAbsolute(env.FILES_ROOT)
      ? env.FILES_ROOT
      : resolve('..', 'api', env.FILES_ROOT);
    this.adminUrl = env.ADMIN_URL;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<TelegramDepositCardPayload>(QUEUES.telegramDepositCard, async (data) => {
      await this.sync(telegramDepositCardPayloadSchema.parse(data).depositId);
    });
    this.logger.log(`Working ${QUEUES.telegramDepositCard}`);
  }

  /** `db` lets a test run the job inside its own transaction (a savepoint). */
  async sync(depositId: string, db: Database | Transaction = this.db): Promise<DepositCardOutcome> {
    const [deposit] = await db.select().from(deposits).where(eq(deposits.id, depositId));
    if (!deposit) return 'none';
    const [link] = await db
      .select({ chatId: telegramLinks.chatId })
      .from(telegramLinks)
      .where(isNull(telegramLinks.unlinkedAt));
    if (!this.bot.configured || !link) return 'skipped';
    const view = await this.view(db, deposit);
    if (!view) return 'none';
    const [card] = await db
      .select()
      .from(telegramDepositCards)
      .where(
        and(
          eq(telegramDepositCards.depositId, deposit.id),
          eq(telegramDepositCards.submittedAt, view.submittedAt),
        ),
      );
    const message = renderDepositCard(view, { admin: this.adminUrl });
    try {
      if (!view.outcome) {
        if (card) return 'none';
        const messageId = await this.send(db, deposit, link.chatId, view, message);
        await db
          .insert(telegramDepositCards)
          .values({
            depositId: deposit.id,
            submittedAt: view.submittedAt,
            chatId: link.chatId,
            messageId,
          })
          .onConflictDoNothing();
        return 'sent';
      }
      // Only the card in the live chat: a chat linked before is not told outcomes.
      if (!card || card.chatId !== link.chatId) return 'none';
      await this.edit(card, view, message);
      await db
        .update(telegramDepositCards)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(telegramDepositCards.depositId, card.depositId),
            eq(telegramDepositCards.submittedAt, card.submittedAt),
          ),
        );
      return 'edited';
    } catch (error) {
      if (error instanceof TelegramApiError && FINAL_STATUSES.has(error.status)) {
        this.logger.warn(`Telegram refused the card of deposit ${deposit.id}: ${error.message}`);
        return 'failed';
      }
      throw error;
    }
  }

  /** Sends the card: the receipt as a JPEG photo with the caption, else a text message. */
  private async send(
    db: Database | Transaction,
    deposit: DepositRow,
    chatId: number,
    view: DepositCardView,
    message: RenderedTelegramMessage,
  ): Promise<number> {
    const markup = { reply_markup: { inline_keyboard: keyboard(message) } };
    const photo = view.usdt ? null : await this.receiptJpeg(db, deposit.id);
    const sent = (
      photo
        ? await this.bot.callWithFile(
            'sendPhoto',
            { chat_id: chatId, caption: message.text, ...markup },
            { field: 'photo', name: `${view.referenceCode}.jpg`, type: 'image/jpeg', bytes: photo },
          )
        : await this.bot.call('sendMessage', { chat_id: chatId, text: message.text, ...markup })
    ) as { message_id?: number } | undefined;
    if (typeof sent?.message_id !== 'number') throw new Error('Telegram sent no message id');
    return sent.message_id;
  }

  /** Edits the card's caption (a photo) or text, and removes its buttons (rule TC6). */
  private async edit(
    card: typeof telegramDepositCards.$inferSelect,
    view: DepositCardView,
    message: RenderedTelegramMessage,
  ): Promise<void> {
    const target = { chat_id: card.chatId, message_id: card.messageId };
    const markup = { reply_markup: { inline_keyboard: [] } };
    try {
      if (view.usdt) {
        await this.bot.call('editMessageText', { ...target, text: message.text, ...markup });
      } else {
        await this.bot.call('editMessageCaption', { ...target, caption: message.text, ...markup });
      }
    } catch (error) {
      if (error instanceof TelegramApiError && NOT_MODIFIED.test(error.message)) return;
      throw error;
    }
  }

  /**
   * The newest receipt, re-encoded to JPEG for Telegram (rule TC2); null when its file cannot be
   * read, so the card still arrives as text.
   */
  private async receiptJpeg(db: Database | Transaction, depositId: string): Promise<Buffer | null> {
    const [receipt] = await db
      .select({ storageKey: storedFiles.storageKey })
      .from(depositReceipts)
      .innerJoin(storedFiles, eq(storedFiles.id, depositReceipts.fileId))
      .where(eq(depositReceipts.depositId, depositId))
      .orderBy(desc(depositReceipts.createdAt), desc(depositReceipts.id))
      .limit(1);
    if (!receipt) return null;
    const file = pathUnderRoot(this.filesRoot, receipt.storageKey);
    try {
      return await sharp(await readFile(file))
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (error) {
      this.logger.warn(`Receipt of deposit ${depositId} not readable: ${(error as Error).name}`);
      return null;
    }
  }

  /** What the card shows now; null for a deposit that never had a card to show. */
  private async view(
    db: Database | Transaction,
    deposit: DepositRow,
  ): Promise<DepositCardView | null> {
    if (!deposit.submittedAt) return null;
    const [usdt] =
      deposit.method === 'sham_cash'
        ? []
        : await db
            .select({
              checkStatus: usdtDeposits.checkStatus,
              payAmountUnits: usdtDeposits.payAmountUnits,
              transfer: usdtTransfers,
            })
            .from(usdtDeposits)
            .leftJoin(usdtTransfers, eq(usdtTransfers.id, usdtDeposits.transferId))
            .where(eq(usdtDeposits.depositId, deposit.id));
    if (usdt && !usdt.transfer) return null;
    // A decision from Telegram is keyed by its prompt's id (S05 rule TC4).
    const [fromTelegram] = deposit.decisionIdempotencyKey
      ? await db
          .select({ id: telegramPrompts.id })
          .from(telegramPrompts)
          .where(eq(telegramPrompts.id, deposit.decisionIdempotencyKey))
      : [];
    const outcome = outcomeOf(deposit, Boolean(fromTelegram));
    // A USDT deposit has a card only once in review (rule TC1); before that nothing to show.
    if (usdt && !outcome && (deposit.status !== 'submitted' || usdt.checkStatus !== 'review')) {
      return null;
    }
    const [[customer], [credited], flags, [settings]] = await Promise.all([
      db
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, deposit.customerId)),
      db
        .select({ count: count() })
        .from(deposits)
        .where(
          and(
            eq(deposits.customerId, deposit.customerId),
            eq(deposits.status, 'credited'),
            ne(deposits.id, deposit.id),
          ),
        ),
      db
        .selectDistinct({ code: depositFlags.code })
        .from(depositFlags)
        .where(eq(depositFlags.depositId, deposit.id))
        .orderBy(depositFlags.code),
      db
        .select({ limit: depositSettings.telegramApprovalMaxUsdUnits })
        .from(depositSettings)
        .orderBy(desc(depositSettings.createdAt), desc(depositSettings.id))
        .limit(1),
    ]);
    const refusal = telegramApprovalRefusal({
      method: deposit.method,
      flagCount: flags.length,
      creditUsdUnits: deposit.declaredUsdUnits,
      limitUsdUnits: settings?.limit ?? 0,
    });
    return {
      id: deposit.id,
      referenceCode: deposit.referenceCode,
      method: deposit.method,
      currency: deposit.currency,
      declaredAmountUnits: deposit.declaredAmountUnits,
      declaredUsdUnits: deposit.declaredUsdUnits,
      rate: deposit.rate && rateFromNumeric(deposit.rate),
      customerName: customer?.name ?? '',
      creditedCount: credited?.count ?? 0,
      flags: flags.map((flag) => flag.code),
      submittedAt: deposit.submittedAt,
      approval: refusal ? { refusal } : { creditUsdUnits: deposit.declaredUsdUnits },
      usdt: usdt?.transfer
        ? {
            receivedUnits: usdt.transfer.amountUnits,
            expectedUnits: usdt.payAmountUnits,
            txid: usdt.transfer.txid,
          }
        : null,
      outcome,
    };
  }
}

/** What a decided, sent-back, expired or cancelled deposit's card says (rule TC6). */
function outcomeOf(deposit: DepositRow, fromTelegram: boolean): DepositCardView['outcome'] {
  switch (deposit.status) {
    case 'credited':
      return {
        kind: 'credited',
        creditedUsdUnits: deposit.creditedUsdUnits ?? 0,
        channel: deposit.decidedBy === 'system' ? 'worker' : fromTelegram ? 'telegram' : 'admin',
      };
    case 'rejected':
      return deposit.rejectReason ? { kind: 'rejected', reason: deposit.rejectReason } : null;
    case 'expired':
      return { kind: 'expired' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'pending':
      return deposit.receiptRequestedAt ? { kind: 'receipt_requested' } : null;
    default:
      return null;
  }
}

function keyboard(message: RenderedTelegramMessage) {
  return (message.buttons ?? []).map((row) =>
    row.map((button) => ({ text: button.text, callback_data: button.data })),
  );
}

/**
 * The absolute path of a key under the files root; throws when the key leaves it. `paths` is the
 * platform's path module (posix or win32), so both separators are checked the same way. Same check
 * as the API's file storage (apps/api/src/modules/files/file-storage.ts).
 */
export function pathUnderRoot(root: string, key: string, paths: PlatformPath = path): string {
  const full = paths.resolve(root, key);
  const relative = paths.relative(root, full);
  if (relative === '' || relative.startsWith('..') || paths.isAbsolute(relative)) {
    throw new Error('A file key left the files root');
  }
  return full;
}
