import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  TELEGRAM_LINK_CODE_TTL_SECONDS,
  type TelegramLinkCode,
  type TelegramLinkStatus,
} from '@vertex-digital/contracts';
import {
  type Database,
  newId,
  queueTelegramMessage,
  recordAudit,
  type Transaction,
  telegramLinkCodes,
  telegramLinks,
  telegramMessages,
} from '@vertex-digital/db';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';

type Executor = Database | Transaction;

export type TelegramLink = typeof telegramLinks.$inferSelect;

/** Link changes serialize on this lock (rule TG3), so two links never race the live-link index. */
const LINK_KEY = sql`hashtext('telegram_link')`;

/** The SHA-256 stored for a link code: the code itself is never stored (rule TG3). */
export const linkCodeDigest = (code: string) => createHash('sha256').update(code).digest();

const notConfigured = () =>
  new CodedException(409, 'TELEGRAM_NOT_CONFIGURED', 'The Telegram bot is not configured');

/**
 * The Telegram admin bot's panel side (S05 F07, rules TG1, TG3): the link status, link codes,
 * unlinking and the test message. The bot's own updates are `TelegramBotService`'s.
 */
@Injectable()
export class TelegramService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
  ) {}

  get configured(): boolean {
    return Boolean(this.env.TELEGRAM_BOT_USERNAME && this.env.TELEGRAM_WEBHOOK_SECRET);
  }

  /** The live link, or undefined; a link change reads it after `lockLinks`. */
  async liveLink(executor: Executor = this.db): Promise<TelegramLink | undefined> {
    const [link] = await executor
      .select()
      .from(telegramLinks)
      .where(isNull(telegramLinks.unlinkedAt));
    return link;
  }

  async lockLinks(tx: Transaction): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${LINK_KEY})`);
  }

  /** `GET /api/admin/telegram`. */
  async status(executor: Executor = this.db): Promise<TelegramLinkStatus> {
    const [link, [message]] = await Promise.all([
      this.liveLink(executor),
      executor
        .select()
        .from(telegramMessages)
        .orderBy(desc(telegramMessages.createdAt), desc(telegramMessages.id))
        .limit(1),
    ]);
    return {
      configured: this.configured,
      link: link ? { username: link.telegramUsername, since: link.linkedAt.toISOString() } : null,
      lastMessage: message
        ? {
            kind: message.kind,
            status: message.status,
            createdAt: message.createdAt.toISOString(),
            sentAt: message.sentAt?.toISOString() ?? null,
            error: message.lastError,
          }
        : null,
    };
  }

  /** `POST /api/admin/telegram/link-code` (rule TG3): 128 random bits, shown once. */
  async createLinkCode(adminId: string, meta: RequestMeta): Promise<TelegramLinkCode> {
    if (!this.configured) throw notConfigured();
    const code = randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + TELEGRAM_LINK_CODE_TTL_SECONDS * 1000);
    await this.db.transaction(async (tx) => {
      const id = newId();
      await tx
        .insert(telegramLinkCodes)
        .values({ id, adminId, codeSha256: linkCodeDigest(code), expiresAt });
      await recordAudit(tx, {
        action: 'telegram.link_code_created',
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        entityType: 'telegram_link',
        entityId: id,
        reason: null,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { expiresAt: expiresAt.toISOString() },
      });
    });
    return {
      deepLink: `https://t.me/${this.env.TELEGRAM_BOT_USERNAME}?start=${code}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** `DELETE /api/admin/telegram/link`: ends the live link at once; nothing to end is a no-op. */
  async unlink(adminId: string, meta: RequestMeta): Promise<TelegramLinkStatus> {
    return this.db.transaction(async (tx) => {
      await this.lockLinks(tx);
      const link = await this.liveLink(tx);
      if (link) {
        await tx
          .update(telegramLinks)
          .set({ unlinkedAt: new Date() })
          .where(eq(telegramLinks.id, link.id));
        await recordAudit(tx, {
          action: 'telegram.unlinked',
          actorKind: 'admin',
          actorId: adminId,
          channel: 'admin',
          entityType: 'telegram_link',
          entityId: link.id,
          reason: null,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          details: { linkId: link.id },
        });
      }
      return this.status(tx);
    });
  }

  /** `POST /api/admin/telegram/test`: a message to the linked chat, sent by the worker. */
  async sendTest(): Promise<void> {
    if (!this.configured) throw notConfigured();
    await this.db.transaction(async (tx) => {
      if (!(await this.liveLink(tx))) {
        throw new CodedException(404, 'NOT_FOUND', 'No Telegram chat is linked');
      }
      await queueTelegramMessage(tx, this.jobs, { kind: 'test', params: {} });
    });
  }
}
