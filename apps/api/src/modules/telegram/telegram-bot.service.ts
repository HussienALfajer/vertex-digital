import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  parseTelegramCallback,
  STOP_SCOPE_SWITCHES,
  type StopScope,
  TELEGRAM_PROMPT_DATA,
  TELEGRAM_PROMPT_TTL_SECONDS,
  type TelegramBotReply,
  type TelegramUpdate,
  telegramLinkCodeValueSchema,
  telegramUpdateSchema,
} from '@vertex-digital/contracts';
import {
  type Database,
  newId,
  queueTelegramMessage,
  recordAudit,
  type Transaction,
  telegramLinkCodes,
  telegramLinks,
  telegramPrompts,
  telegramUpdates,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { DepositReviewService } from '../deposits/index.js';
import { SettingsService } from '../settings/index.js';
import { linkCodeDigest, type TelegramLink, TelegramService } from './telegram.service.js';

/** The inline answer to a button press, sent back in the webhook response (rule TG2). */
export interface CallbackAnswer {
  method: 'answerCallbackQuery';
  callback_query_id: string;
  text?: string;
}

type Message = NonNullable<TelegramUpdate['message']>;
type CallbackQuery = NonNullable<TelegramUpdate['callback_query']>;

/** `/start <code>`, `/status`, `/stop`, `/help`, with an optional `@botname` (rule AL4). */
const COMMAND = /^\/(start|status|stop|help)(?:@\w+)?(?:\s+(\S+))?\s*$/;

/** Inline answers: short, Arabic, shown as a toast on the admin's phone. */
const ANSWERS = {
  stopped: 'تم الإيقاف. إعادة الفتح من اللوحة فقط.',
  alreadyStopped: 'متوقف مسبقاً. إعادة الفتح من اللوحة فقط.',
  cancelled: 'أُلغي.',
  expired: 'انتهت صلاحية هذا السؤال. أرسل الأمر من جديد.',
  failed: 'تعذّر التنفيذ. حاول من اللوحة.',
} as const;

/**
 * The bot's updates (S05 F07, rules TG2–TG7, AL4), from `POST /api/webhooks/telegram`. Every
 * action runs through the panel's services with the channel `telegram`; the API never calls
 * Telegram: replies are outbox rows the worker sends, a button press is answered inline.
 */
@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly secretDigest: Buffer | null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
    private readonly jobs: JobsService,
    private readonly telegram: TelegramService,
    private readonly settings: SettingsService,
    private readonly deposits: DepositReviewService,
  ) {
    this.secretDigest = env.TELEGRAM_WEBHOOK_SECRET ? digest(env.TELEGRAM_WEBHOOK_SECRET) : null;
  }

  /** Rule TG4: the secret header, compared in constant time; false while not configured. */
  verifySecret(header: string | undefined): boolean {
    if (!this.secretDigest || !this.telegram.configured || typeof header !== 'string') {
      return false;
    }
    return timingSafeEqual(digest(header), this.secretDigest);
  }

  /**
   * Handles one update. A redelivered `update_id` does nothing (rule TG5). The webhook answers
   * 200 whatever happens, so Telegram never retries: a failed action rolls back, then the update
   * is recorded and the failure is told in the chat.
   */
  async handle(body: unknown, meta: RequestMeta): Promise<CallbackAnswer | null> {
    const parsed = telegramUpdateSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn('Ignored a Telegram update that does not match the expected shape');
      return null;
    }
    const update = parsed.data;
    try {
      return await this.db.transaction(async (tx) => {
        if (!(await this.recordUpdate(tx, update.update_id))) return null;
        return this.act(tx, update, meta);
      });
    } catch (error) {
      this.logger.error(
        withoutQueryParameters(error),
        `Telegram update ${update.update_id} failed`,
      );
      return this.db.transaction(async (tx) => {
        if (!(await this.recordUpdate(tx, update.update_id))) return null;
        const link = await this.telegram.liveLink(tx);
        const sender = senderOf(update);
        if (!link || !sender || !isLinked(link, sender)) return null;
        if (update.callback_query) return answer(update.callback_query, ANSWERS.failed);
        await this.reply(tx, link.chatId, { reply: 'failed' });
        return null;
      });
    }
  }

  /** False when the update was already handled. */
  private async recordUpdate(tx: Transaction, updateId: number): Promise<boolean> {
    const inserted = await tx
      .insert(telegramUpdates)
      .values({ updateId })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdates.updateId });
    return inserted.length > 0;
  }

  private async act(
    tx: Transaction,
    update: TelegramUpdate,
    meta: RequestMeta,
  ): Promise<CallbackAnswer | null> {
    if (update.message) {
      await this.onMessage(tx, update.message);
      return null;
    }
    if (update.callback_query) return this.onCallback(tx, update.callback_query, meta);
    return null;
  }

  private async onMessage(tx: Transaction, message: Message): Promise<void> {
    const command = COMMAND.exec(message.text?.trim() ?? '');
    if (command?.[1] === 'start' && command[2] && message.chat.type === 'private' && message.from) {
      await this.link(tx, message, command[2]);
      return;
    }
    const link = await this.telegram.liveLink(tx);
    if (
      !link ||
      !message.from ||
      !isLinked(link, { userId: message.from.id, chatId: message.chat.id })
    ) {
      return;
    }
    switch (command?.[1]) {
      case 'status': {
        const [switches, counts] = await Promise.all([
          this.settings.values(tx),
          this.deposits.waitingCounts(),
        ]);
        await this.reply(tx, link.chatId, { reply: 'status', switches, ...counts });
        return;
      }
      case 'stop': {
        const values = await this.settings.values(tx);
        const stopped = values.purchases_stopped && values.deposits_stopped;
        await this.reply(tx, link.chatId, { reply: stopped ? 'stop_already' : 'stop_choose' });
        return;
      }
      default:
        // `/help`, `/start` without a code, or text no open question waits for (rule TG7).
        await this.reply(tx, link.chatId, { reply: 'help' });
    }
  }

  /** Rule TG3: `/start <code>` in a private chat links that chat; any other code is refused. */
  private async link(tx: Transaction, message: Message, code: string): Promise<void> {
    const from = message.from as NonNullable<Message['from']>;
    const chatId = message.chat.id;
    await this.telegram.lockLinks(tx);
    const [row] = telegramLinkCodeValueSchema.safeParse(code).success
      ? await tx
          .select()
          .from(telegramLinkCodes)
          .where(
            and(
              eq(telegramLinkCodes.codeSha256, linkCodeDigest(code)),
              isNull(telegramLinkCodes.usedAt),
              gt(telegramLinkCodes.expiresAt, new Date()),
            ),
          )
          .for('update')
      : [];
    if (!row) {
      await this.reply(tx, chatId, { reply: 'invalid_code' });
      return;
    }
    const now = new Date();
    await tx.update(telegramLinkCodes).set({ usedAt: now }).where(eq(telegramLinkCodes.id, row.id));
    const previous = await this.telegram.liveLink(tx);
    if (previous) {
      await tx
        .update(telegramLinks)
        .set({ unlinkedAt: now })
        .where(eq(telegramLinks.id, previous.id));
      if (previous.chatId !== chatId) {
        await queueTelegramMessage(tx, this.jobs, {
          kind: 'link_changed',
          params: {},
          chatId: previous.chatId,
        });
      }
    }
    const id = newId();
    await tx.insert(telegramLinks).values({
      id,
      adminId: row.adminId,
      chatId,
      telegramUserId: from.id,
      telegramUsername: from.username ?? null,
      linkedAt: now,
    });
    await recordAudit(tx, {
      action: 'telegram.linked',
      actorKind: 'admin',
      actorId: row.adminId,
      channel: 'telegram',
      entityType: 'telegram_link',
      entityId: id,
      reason: null,
      ipAddress: null,
      userAgent: null,
      details: { telegramUserId: from.id, previousLinkId: previous?.id ?? null },
    });
    await this.reply(tx, chatId, { reply: 'welcome' });
  }

  private async onCallback(
    tx: Transaction,
    query: CallbackQuery,
    meta: RequestMeta,
  ): Promise<CallbackAnswer | null> {
    const link = await this.telegram.liveLink(tx);
    if (!link || !query.message) return null;
    if (!isLinked(link, { userId: query.from.id, chatId: query.message.chat.id })) return null;
    const callback = parseTelegramCallback(query.data ?? '');
    if (!callback) return answer(query);
    if (callback.action === 'stop') {
      if (await this.alreadyStopped(tx, callback.scope)) {
        return answer(query, ANSWERS.alreadyStopped);
      }
      const promptId = await this.openPrompt(tx, callback.scope);
      await this.reply(tx, link.chatId, { reply: 'stop_confirm', promptId, scope: callback.scope });
      return answer(query);
    }
    const [prompt] = await tx
      .select()
      .from(telegramPrompts)
      .where(eq(telegramPrompts.id, callback.promptId))
      .for('update');
    if (!prompt || prompt.closedAt || prompt.expiresAt <= new Date()) {
      return answer(query, ANSWERS.expired);
    }
    await tx
      .update(telegramPrompts)
      .set({ closedAt: new Date() })
      .where(eq(telegramPrompts.id, prompt.id));
    if (callback.action === 'cancel') return answer(query, ANSWERS.cancelled);
    const { scope } = TELEGRAM_PROMPT_DATA.stop_confirm.parse(prompt.data);
    let changed = false;
    for (const name of STOP_SCOPE_SWITCHES[scope]) {
      // Rule SW3: Telegram only turns stops on; each change sends its own notice (AL2).
      if (
        await this.settings.changeIn(
          tx,
          link.adminId,
          { switch: name, value: true },
          'telegram',
          meta,
        )
      ) {
        changed = true;
      }
    }
    return answer(query, changed ? ANSWERS.stopped : ANSWERS.alreadyStopped);
  }

  private async alreadyStopped(tx: Transaction, scope: StopScope): Promise<boolean> {
    const values = await this.settings.values(tx);
    return STOP_SCOPE_SWITCHES[scope].every((name) => values[name]);
  }

  /** Rule TG7: opening a question closes any other. */
  private async openPrompt(tx: Transaction, scope: StopScope): Promise<string> {
    const now = new Date();
    await tx.update(telegramPrompts).set({ closedAt: now }).where(isNull(telegramPrompts.closedAt));
    const id = newId();
    await tx.insert(telegramPrompts).values({
      id,
      kind: 'stop_confirm',
      data: TELEGRAM_PROMPT_DATA.stop_confirm.parse({ scope }),
      expiresAt: new Date(now.getTime() + TELEGRAM_PROMPT_TTL_SECONDS * 1000),
    });
    return id;
  }

  private reply(tx: Transaction, chatId: number, params: TelegramBotReply) {
    return queueTelegramMessage(tx, this.jobs, { kind: 'bot_reply', params, chatId });
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

interface Sender {
  userId: number;
  chatId: number;
}

/** Rule TG4: only the linked user, in the linked chat. */
const isLinked = (link: TelegramLink, sender: Sender) =>
  link.telegramUserId === sender.userId && link.chatId === sender.chatId;

function senderOf(update: TelegramUpdate): Sender | null {
  if (update.message?.from) {
    return { userId: update.message.from.id, chatId: update.message.chat.id };
  }
  const query = update.callback_query;
  return query?.message ? { userId: query.from.id, chatId: query.message.chat.id } : null;
}

function answer(query: CallbackQuery, text?: string): CallbackAnswer {
  return {
    method: 'answerCallbackQuery',
    callback_query_id: query.id,
    ...(text && { text }),
  };
}
