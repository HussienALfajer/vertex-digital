import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateTicket,
  type CursorQuery,
  customerCanReply,
  type SupportChannels,
  TICKET_LIMITS,
  type Ticket,
  type TicketPage,
  ticketNoticeKey,
  ticketTransition,
} from '@vertex-digital/contracts';
import {
  type Database,
  findCustomer,
  queueTelegramMessage,
  recordAudit,
  supportMessages,
  supportSettings,
  supportTickets,
  type Transaction,
} from '@vertex-digital/db';
import { and, count, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { FilesService, type ServedFile } from '../files/index.js';
import {
  checkLink,
  insertMessage,
  insertTicket,
  isUuid,
  lockTicket,
  messageByKey,
  type TicketRow,
  ticketChange,
  ticketHoldsFile,
  ticketMessages,
  ticketRefusals,
  ticketSummary,
  updateTicket,
} from './support-records.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The customer's tickets (S12 F23, rules TK1, TK3, TK4, TK7, TK8, TK11, TK12) and the public
 * support channels (SC2). Every query filters by the session's customer: another customer's ticket
 * or image answers `404`. A customer's ticket writes queue on one advisory lock, so the limits
 * see each other; the images are re-encoded before the transaction (an orphan file of a refused
 * request is never served).
 */
@Injectable()
export class SupportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
  ) {}

  /** `GET /api/support/channels` (SC2). */
  async channels(): Promise<SupportChannels> {
    const [row] = await this.db
      .select({ telegramUrl: supportSettings.telegramUrl })
      .from(supportSettings);
    return { telegramUrl: row?.telegramUrl ?? null };
  }

  /** `GET /api/support/tickets`: newest activity first (TK12). */
  async list(customerId: string, query: CursorQuery): Promise<TicketPage> {
    const rows = await this.db
      .select({ ticket: supportTickets, cursorAt: cursorTime(supportTickets.updatedAt) })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.customerId, customerId),
          query.cursor
            ? after(supportTickets.updatedAt, supportTickets.id, decodeCursor(query.cursor))
            : undefined,
        ),
      )
      .orderBy(desc(supportTickets.updatedAt), desc(supportTickets.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.ticket.id }));
    return {
      items: await Promise.all(page.items.map((row) => ticketSummary(this.db, row.ticket))),
      nextCursor: page.nextCursor,
    };
  }

  /** `GET /api/support/tickets/:id`. */
  async ticket(customerId: string, id: string): Promise<Ticket> {
    return this.view(await this.own(this.db, customerId, id));
  }

  /** `POST /api/support/tickets` (TK1): the same key and body return the first ticket. */
  async open(
    customerId: string,
    idempotencyKey: string,
    input: CreateTicket & { orderId?: string | undefined; depositId?: string | undefined },
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: Ticket; created: boolean }> {
    const replayed = await this.replay(this.db, customerId, idempotencyKey, input.body, null);
    if (replayed) return { ticket: await this.ticket(customerId, replayed), created: false };
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const outcome = await this.db.transaction(async (tx) => {
      await this.lock(tx, customerId, idempotencyKey);
      const again = await this.replay(tx, customerId, idempotencyKey, input.body, null);
      if (again) return { id: again, created: false };
      const [[open], [today]] = await Promise.all([
        tx
          .select({ count: count() })
          .from(supportTickets)
          .where(
            and(
              eq(supportTickets.customerId, customerId),
              eq(supportTickets.openedBy, 'customer'),
              ne(supportTickets.status, 'closed'),
            ),
          ),
        tx
          .select({ count: count() })
          .from(supportTickets)
          .where(
            and(
              eq(supportTickets.customerId, customerId),
              eq(supportTickets.openedBy, 'customer'),
              gt(supportTickets.createdAt, sql`now() - interval '24 hours'`),
            ),
          ),
      ]);
      if ((open?.count ?? 0) >= TICKET_LIMITS.openPerCustomer) throw ticketRefusals.limit('open');
      if ((today?.count ?? 0) >= TICKET_LIMITS.createdPerDay) throw ticketRefusals.limit('daily');
      await this.checkMessageRate(tx, customerId);
      const link = await checkLink(tx, customerId, input);
      const ticket = await insertTicket(tx, {
        customerId,
        category: input.category,
        ...link,
        subject: input.subject,
        status: 'open',
        openedBy: 'customer',
        lastCustomerMessageAt: sql`now()`,
      });
      const fileIds = [];
      for (const file of prepared) fileIds.push(await this.files.record(tx, file));
      await insertMessage(tx, {
        ticketId: ticket.id,
        author: 'customer',
        body: input.body,
        idempotencyKey,
        fileIds,
      });
      await recordAudit(tx, {
        ...this.entry(customerId, ticket.id, meta),
        action: 'ticket.opened',
        details: ticketChange(ticket, null),
      });
      await this.tellAdmin(tx, ticket, customerId, fileIds.length > 0, 'ticket_opened');
      return { id: ticket.id, created: true };
    });
    return { ticket: await this.ticket(customerId, outcome.id), created: outcome.created };
  }

  /** `POST /api/support/tickets/:id/messages` (TK3, TK4, TK7). */
  async reply(
    customerId: string,
    id: string,
    idempotencyKey: string,
    body: string,
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: Ticket; created: boolean }> {
    await this.own(this.db, customerId, id);
    const replayed = await this.replay(this.db, customerId, idempotencyKey, body, id);
    if (replayed) return { ticket: await this.ticket(customerId, id), created: false };
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const created = await this.db.transaction(async (tx) => {
      await this.lock(tx, customerId, idempotencyKey);
      if (await this.replay(tx, customerId, idempotencyKey, body, id)) return false;
      const ticket = await lockTicket(tx, id);
      if (ticket?.customerId !== customerId) throw ticketRefusals.notFound();
      if (!customerCanReply(ticket, new Date())) throw ticketRefusals.closed();
      if (ticket.status === 'closed' && ticket.openedBy === 'customer') {
        const [open] = await tx
          .select({ count: count() })
          .from(supportTickets)
          .where(
            and(
              eq(supportTickets.customerId, customerId),
              eq(supportTickets.openedBy, 'customer'),
              ne(supportTickets.status, 'closed'),
            ),
          );
        if ((open?.count ?? 0) >= TICKET_LIMITS.openPerCustomer) {
          throw ticketRefusals.limit('open');
        }
      }
      await this.checkMessageRate(tx, customerId);
      const status = ticketTransition(ticket.status, 'customer_message') ?? ticket.status;
      const updated = await updateTicket(tx, ticket, {
        status,
        lastCustomerMessageAt: sql`now()`,
        closedAt: null,
        closedBy: null,
      });
      const fileIds = [];
      for (const file of prepared) fileIds.push(await this.files.record(tx, file));
      const messageId = await insertMessage(tx, {
        ticketId: ticket.id,
        author: 'customer',
        body,
        idempotencyKey,
        fileIds,
      });
      await recordAudit(tx, {
        ...this.entry(customerId, ticket.id, meta),
        action: 'ticket.customer_replied',
        details: {
          ticketId: ticket.id,
          category: ticket.category,
          messageId,
          before: ticket.status,
          after: updated.status,
          images: fileIds.length,
        },
      });
      if (ticket.status === 'closed') {
        await recordAudit(tx, {
          ...this.entry(customerId, ticket.id, meta),
          action: 'ticket.reopened',
          details: ticketChange(updated, ticket.status),
        });
      }
      await this.tellAdmin(tx, ticket, customerId, fileIds.length > 0, 'ticket_reply');
      return true;
    });
    return { ticket: await this.ticket(customerId, id), created };
  }

  /** `POST /api/support/tickets/:id/close`: a closed ticket is returned unchanged. */
  async close(customerId: string, id: string, meta: RequestMeta): Promise<Ticket> {
    await this.db.transaction(async (tx) => {
      const ticket = await lockTicket(tx, id);
      if (ticket?.customerId !== customerId) throw ticketRefusals.notFound();
      if (ticketTransition(ticket.status, 'close') === null) return;
      const closed = await updateTicket(tx, ticket, {
        status: 'closed',
        closedAt: sql`now()`,
        closedBy: 'customer',
      });
      await recordAudit(tx, {
        ...this.entry(customerId, ticket.id, meta),
        action: 'ticket.closed',
        details: { ...ticketChange(closed, ticket.status), cause: 'manual' },
      });
    });
    return this.ticket(customerId, id);
  }

  /** `GET …/attachments/:fileId`: an image of the customer's own ticket only (TK11). */
  async attachment(customerId: string, id: string, fileId: string): Promise<ServedFile> {
    await this.own(this.db, customerId, id);
    const file =
      isUuid(fileId) && (await ticketHoldsFile(this.db, id, fileId))
        ? await this.files.serve(fileId, 'ticket_attachment')
        : null;
    if (!file) throw ticketRefusals.notFound();
    return file;
  }

  private async view(row: TicketRow): Promise<Ticket> {
    const [summary, messages] = await Promise.all([
      ticketSummary(this.db, row),
      ticketMessages(this.db, row.id),
    ]);
    return { ...summary, canReply: customerCanReply(row, new Date()), messages };
  }

  /** The customer's own ticket; another customer's answers `404` (TK11). */
  private async own(
    db: Database | Transaction,
    customerId: string,
    id: string,
  ): Promise<TicketRow> {
    if (!isUuid(id)) throw ticketRefusals.notFound();
    const [row] = await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, id), eq(supportTickets.customerId, customerId)));
    if (!row) throw ticketRefusals.notFound();
    return row;
  }

  /**
   * The ticket an `Idempotency-Key` already wrote for this customer, or null. The key on another
   * customer's, another author's or another ticket's message, or with another body, is reused.
   */
  private async replay(
    db: Database | Transaction,
    customerId: string,
    idempotencyKey: string,
    body: string,
    ticketId: string | null,
  ): Promise<string | null> {
    const written = await messageByKey(db, idempotencyKey);
    if (!written) return null;
    if (
      written.customerId !== customerId ||
      written.author !== 'customer' ||
      written.body !== body ||
      (ticketId !== null && written.ticketId !== ticketId)
    ) {
      throw ticketRefusals.keyReused();
    }
    return written.ticketId;
  }

  /** One key at a time, then one customer's ticket writes at a time. */
  private async lock(tx: Transaction, customerId: string, idempotencyKey: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`support-key:${idempotencyKey}`}))`,
    );
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`support:${customerId}`}))`);
  }

  /** TK7: 20 customer messages an hour, first messages included. */
  private async checkMessageRate(tx: Transaction, customerId: string): Promise<void> {
    const [row] = await tx
      .select({ count: count() })
      .from(supportMessages)
      .innerJoin(supportTickets, eq(supportTickets.id, supportMessages.ticketId))
      .where(
        and(
          eq(supportTickets.customerId, customerId),
          eq(supportMessages.author, 'customer'),
          gt(supportMessages.createdAt, new Date(Date.now() - HOUR_MS)),
        ),
      );
    if ((row?.count ?? 0) >= TICKET_LIMITS.messagesPerHour) {
      throw new CodedException(429, 'RATE_LIMITED', 'Too many messages, try later');
    }
  }

  /**
   * TK8: the admin's Telegram notice, never the message or images; a reply at most once per ticket
   * per 10 minutes. With no linked chat the worker skips it (S05).
   */
  private async tellAdmin(
    tx: Transaction,
    ticket: TicketRow,
    customerId: string,
    hasImages: boolean,
    kind: 'ticket_opened' | 'ticket_reply',
  ): Promise<void> {
    const customer = await findCustomer(tx, customerId);
    await queueTelegramMessage(tx, this.jobs, {
      kind,
      params: {
        ticketId: ticket.id,
        number: ticket.number,
        category: ticket.category,
        subject: ticket.subject.slice(0, 120),
        hasImages,
        customerEmail: customer?.email ?? '',
      },
      dedupeKey:
        kind === 'ticket_opened'
          ? `ticket:${ticket.id}:opened`
          : ticketNoticeKey(ticket.id, new Date()),
    });
  }

  private entry(customerId: string, ticketId: string, meta: RequestMeta) {
    return {
      actorKind: 'customer',
      actorId: customerId,
      channel: 'store',
      entityType: 'support_ticket',
      entityId: ticketId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}
