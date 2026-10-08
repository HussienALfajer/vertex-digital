import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type DepositRejectReason,
  parseTelegramCallback,
  STOP_SCOPE_SWITCHES,
  type StopScope,
  TELEGRAM_PROMPT_DATA,
  TELEGRAM_PROMPT_TTL_SECONDS,
  type TelegramBotReply,
  type TelegramCallback,
  type TelegramPromptKind,
  type TelegramUpdate,
  telegramLinkCodeValueSchema,
  telegramRejectNoteSchema,
  telegramRejectReasons,
  telegramTransactionNumberSchema,
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
import type { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import {
  DepositReviewService,
  type TelegramDecision,
  type TelegramDepositFacts,
} from '../deposits/index.js';
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
type Prompt = typeof telegramPrompts.$inferSelect;

/** A deposit prompt: it names its deposit and the submission it was opened on. */
type DepositPrompt = Prompt & { depositId: string };

/** `/start <code>`, `/status`, `/stop`, `/help`, with an optional `@botname` (rule AL4). */
const COMMAND = /^\/(start|status|stop|help)(?:@\w+)?(?:\s+(\S+))?\s*$/;

/** Inline answers: short, Arabic, shown as a toast on the admin's phone. */
const ANSWERS = {
  stopped: 'تم الإيقاف. إعادة الفتح من اللوحة فقط.',
  alreadyStopped: 'متوقف مسبقاً. إعادة الفتح من اللوحة فقط.',
  cancelled: 'أُلغي.',
  expired: 'انتهت صلاحية هذا السؤال. أرسل الأمر من جديد.',
  failed: 'تعذّر التنفيذ. حاول من اللوحة.',
  decided: 'تم البت فيه مسبقاً.',
  panelOnly: 'من اللوحة فقط.',
  flagged: 'عليه علامات، اعتمد من اللوحة.',
  overLimit: 'فوق حد تيليجرام، اعتمد من اللوحة.',
  off: 'الاعتماد من تيليجرام متوقف، اعتمد من اللوحة.',
} as const;

const APPROVAL_ANSWERS = {
  panel_only: ANSWERS.panelOnly,
  off: ANSWERS.off,
  flagged: ANSWERS.flagged,
  over_limit: ANSWERS.overLimit,
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
      case 'help':
      case 'start':
        await this.reply(tx, link.chatId, { reply: 'help' });
        return;
      default: {
        // Rule TG7: plain text answers the open question; with none, or past its 10 minutes,
        // the help.
        const prompt = await this.openPromptRow(tx);
        if (prompt && !command && message.text !== undefined) {
          await this.answerPrompt(tx, link, prompt, message.text);
          return;
        }
        await this.reply(tx, link.chatId, { reply: 'help' });
      }
    }
  }

  /** The open, unexpired prompt, locked; null when none. */
  private async openPromptRow(tx: Transaction): Promise<Prompt | null> {
    const [prompt] = await tx
      .select()
      .from(telegramPrompts)
      .where(and(isNull(telegramPrompts.closedAt), gt(telegramPrompts.expiresAt, new Date())))
      .for('update');
    return prompt ?? null;
  }

  /** The admin's text, as the answer to the open question (rules TC4 step 2, TC5). */
  private async answerPrompt(
    tx: Transaction,
    link: TelegramLink,
    prompt: Prompt,
    text: string,
  ): Promise<void> {
    if (!isDepositPrompt(prompt)) {
      // A stop waits for its buttons, not text.
      await this.reply(tx, link.chatId, { reply: 'help' });
      return;
    }
    const facts = await this.deposits.telegramFacts(prompt.depositId);
    if (!facts) throw new Error(`Prompt ${prompt.id} names no deposit`);
    if (prompt.kind === 'approve_number') {
      const number = telegramTransactionNumberSchema.safeParse(text);
      if (!number.success) {
        await this.reply(tx, link.chatId, {
          reply: 'invalid_answer',
          field: 'transaction_number',
        });
        return;
      }
      const promptId = await this.openPrompt(tx, 'approve_confirm', facts, {
        transactionNumber: number.data,
      });
      await this.reply(tx, link.chatId, {
        reply: 'approve_confirm',
        promptId,
        referenceCode: facts.referenceCode,
        creditedUsdUnits: facts.creditUsdUnits,
        transactionNumber: number.data,
      });
      return;
    }
    if (prompt.kind === 'reject_note') {
      const { reason } = TELEGRAM_PROMPT_DATA.reject_note.parse(prompt.data);
      if (!reason) {
        // The reason buttons come first.
        await this.reply(tx, link.chatId, {
          reply: 'reject_reasons',
          promptId: prompt.id,
          referenceCode: facts.referenceCode,
          reasons: telegramRejectReasons(facts.method),
        });
        return;
      }
      const note = telegramRejectNoteSchema.safeParse(text);
      if (!note.success) {
        await this.reply(tx, link.chatId, { reply: 'invalid_answer', field: 'note' });
        return;
      }
      await this.closePrompt(tx, prompt.id);
      const decision = await this.deposits.rejectFromTelegram(
        link.adminId,
        depositPromptRef(prompt),
        reason,
        note.data,
      );
      await this.replyDecision(tx, link, decision);
      return;
    }
    // A confirmation waits for its buttons.
    await this.reply(tx, link.chatId, { reply: 'help' });
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
    switch (callback.action) {
      case 'stop': {
        if (await this.alreadyStopped(tx, callback.scope)) {
          return answer(query, ANSWERS.alreadyStopped);
        }
        const promptId = await this.openPrompt(tx, 'stop_confirm', null, { scope: callback.scope });
        await this.reply(tx, link.chatId, {
          reply: 'stop_confirm',
          promptId,
          scope: callback.scope,
        });
        return answer(query);
      }
      case 'approve':
      case 'reject':
        return this.onDecisionButton(tx, link, query, callback);
      default:
        break;
    }
    const [prompt] = await tx
      .select()
      .from(telegramPrompts)
      .where(eq(telegramPrompts.id, callback.promptId))
      .for('update');
    if (!prompt || prompt.closedAt || prompt.expiresAt <= new Date()) {
      return answer(query, ANSWERS.expired);
    }
    if (callback.action === 'reason')
      return this.onReason(tx, link, query, prompt, callback.reason);
    await this.closePrompt(tx, prompt.id);
    if (callback.action === 'cancel') return answer(query, ANSWERS.cancelled);
    if (prompt.kind === 'approve_confirm' && isDepositPrompt(prompt)) {
      const { transactionNumber } = TELEGRAM_PROMPT_DATA.approve_confirm.parse(prompt.data);
      const decision = await this.deposits.approveFromTelegram(
        link.adminId,
        depositPromptRef(prompt),
        transactionNumber,
      );
      await this.replyDecision(tx, link, decision);
      return answer(query);
    }
    if (prompt.kind !== 'stop_confirm') return answer(query, ANSWERS.expired);
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

  /**
   * "اعتماد" (rule TC4 step 1) or "رفض" (rule TC5) on a card: refused at once when the deposit is
   * decided or panel-only, else the first question. Buttons on an old card meet the same checks.
   */
  private async onDecisionButton(
    tx: Transaction,
    link: TelegramLink,
    query: CallbackQuery,
    callback: Extract<TelegramCallback, { action: 'approve' | 'reject' }>,
  ): Promise<CallbackAnswer> {
    const facts = await this.deposits.telegramFacts(callback.depositId);
    if (!facts?.waiting) return answer(query, ANSWERS.decided);
    if (callback.action === 'approve') {
      if (facts.approvalRefusal) return answer(query, APPROVAL_ANSWERS[facts.approvalRefusal]);
      await this.openPrompt(tx, 'approve_number', facts, {});
      await this.reply(tx, link.chatId, {
        reply: 'approve_number',
        referenceCode: facts.referenceCode,
      });
      return answer(query);
    }
    const promptId = await this.openPrompt(tx, 'reject_note', facts, { reason: null });
    await this.reply(tx, link.chatId, {
      reply: 'reject_reasons',
      promptId,
      referenceCode: facts.referenceCode,
      reasons: telegramRejectReasons(facts.method),
    });
    return answer(query);
  }

  /** A reason button (rule TC5): kept on the prompt, then the note is asked for. */
  private async onReason(
    tx: Transaction,
    link: TelegramLink,
    query: CallbackQuery,
    prompt: Prompt,
    reason: DepositRejectReason,
  ): Promise<CallbackAnswer> {
    if (prompt.kind !== 'reject_note' || !isDepositPrompt(prompt)) {
      return answer(query, ANSWERS.expired);
    }
    const facts = await this.deposits.telegramFacts(prompt.depositId);
    if (!facts?.waiting) return answer(query, ANSWERS.decided);
    if (!telegramRejectReasons(facts.method).includes(reason)) return answer(query);
    await tx
      .update(telegramPrompts)
      .set({ data: TELEGRAM_PROMPT_DATA.reject_note.parse({ reason }) })
      .where(eq(telegramPrompts.id, prompt.id));
    await this.reply(tx, link.chatId, {
      reply: 'reject_note',
      referenceCode: facts.referenceCode,
      reason,
    });
    return answer(query);
  }

  /** The decision's outcome in the chat (rule TC4 step 4); the card is edited by the worker. */
  private async replyDecision(
    tx: Transaction,
    link: TelegramLink,
    decision: TelegramDecision,
  ): Promise<void> {
    const { referenceCode } = decision;
    switch (decision.outcome) {
      case 'approved':
        await this.reply(tx, link.chatId, {
          reply: 'approved',
          referenceCode,
          creditedUsdUnits: decision.creditedUsdUnits,
        });
        return;
      case 'rejected':
        // The rejection's reason is on the card and the deposit page.
        await this.reply(tx, link.chatId, {
          reply: 'rejected',
          referenceCode,
          reason: decision.reason,
        });
        return;
      default:
        await this.reply(tx, link.chatId, {
          reply: 'decision_refused',
          referenceCode,
          refusal: decision.refusal,
        });
    }
  }

  private async alreadyStopped(tx: Transaction, scope: StopScope): Promise<boolean> {
    const values = await this.settings.values(tx);
    return STOP_SCOPE_SWITCHES[scope].every((name) => values[name]);
  }

  /** Rule TG7: opening a question closes any other. A deposit question names its submission. */
  private async openPrompt<Kind extends TelegramPromptKind>(
    tx: Transaction,
    kind: Kind,
    deposit: TelegramDepositFacts | null,
    data: z.input<(typeof TELEGRAM_PROMPT_DATA)[Kind]>,
  ): Promise<string> {
    const now = new Date();
    await tx.update(telegramPrompts).set({ closedAt: now }).where(isNull(telegramPrompts.closedAt));
    const id = newId();
    await tx.insert(telegramPrompts).values({
      id,
      kind,
      depositId: deposit?.id ?? null,
      depositSubmittedAt: deposit?.submittedAt ?? null,
      data: TELEGRAM_PROMPT_DATA[kind].parse(data),
      expiresAt: new Date(now.getTime() + TELEGRAM_PROMPT_TTL_SECONDS * 1000),
    });
    return id;
  }

  private async closePrompt(tx: Transaction, id: string): Promise<void> {
    await tx
      .update(telegramPrompts)
      .set({ closedAt: new Date() })
      .where(eq(telegramPrompts.id, id));
  }

  private reply(tx: Transaction, chatId: number, params: TelegramBotReply) {
    return queueTelegramMessage(tx, this.jobs, { kind: 'bot_reply', params, chatId });
  }
}

const isDepositPrompt = (prompt: Prompt): prompt is DepositPrompt => prompt.depositId !== null;

const depositPromptRef = (prompt: DepositPrompt) => ({
  id: prompt.id,
  depositId: prompt.depositId,
  submittedAt: prompt.depositSubmittedAt,
});

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
