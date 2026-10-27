import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateTicket,
  type CursorQuery,
  customerCanReply,
  type OrderProblem,
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
  lockTicketCustomer,
  queueTelegramMessage,
  readAll,
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
  ticketSummaries,
  ticketSummary,
  updateTicket,
} from './support-records.js';

const HOUR_MS = 60 * 60 * 1000;

/** What a customer's new ticket is about: its first message's key replays only the same. */
type TicketOpening = Pick<CreateTicket, 'category' | 'subject'> & {
  orderId?: string | undefined;
  depositId?: string | undefined;
};

const sameOpening = (
  written: { category: string; orderId: string | null; depositId: string | null; subject: string },
  opening: TicketOpening,
) =>
  written.category === opening.category &&
  written.orderId === (opening.orderId ?? null) &&
  written.depositId === (opening.depositId ?? null) &&
  written.subject === opening.subject;

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
      items: await ticketSummaries(
        this.db,
        page.items.map((row) => row.ticket),
      ),
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
    input: CreateTicket & {
      orderId?: string | undefined;
      depositId?: string | undefined;
      orderProblem?: OrderProblem | undefined;
    },
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: Ticket; created: boolean }> {
    const replayed = await this.replay(this.db, customerId, idempotencyKey, input.body, input);
    if (replayed) return { ticket: await this.ticket(customerId, replayed), created: false };
    // Audit A07-1: a request sure to be refused stores no image; the transaction checks again.
    if (uploads.length > 0) await this.checkOpen(this.db, customerId, input);
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const outcome = await this.db.transaction(async (tx) => {
      await this.lock(tx, customerId, idempotencyKey);
      const again = await this.replay(tx, customerId, idempotencyKey, input.body, input);
      if (again) return { id: again, created: false };
      await this.lockCustomer(tx, customerId);
      const link = await this.checkOpen(tx, customerId, input);
      const ticket = await insertTicket(tx, {
        customerId,
        category: input.category,
        ...link,
        subject: input.subject,
        orderProblem: input.orderProblem ?? null,
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
        details: {
          ...ticketChange(ticket, null),
          ...(ticket.orderProblem !== null && { orderProblem: ticket.orderProblem }),
        },
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
    const own = await this.own(this.db, customerId, id);
    const replayed = await this.replay(this.db, customerId, idempotencyKey, body, id);
    if (replayed) return { ticket: await this.ticket(customerId, id), created: false };
    // Audit A07-1: a request sure to be refused stores no image; the transaction checks again.
    if (uploads.length > 0) await this.checkReply(this.db, customerId, own);
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const created = await this.db.transaction(async (tx) => {
      await this.lock(tx, customerId, idempotencyKey);
      if (await this.replay(tx, customerId, idempotencyKey, body, id)) return false;
      await this.lockCustomer(tx, customerId);
      const ticket = await lockTicket(tx, id);
      if (ticket?.customerId !== customerId) throw ticketRefusals.notFound();
      await this.checkReply(tx, customerId, ticket);
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
    // Audit A07-4: a malformed id is a missing ticket, not a database error.
    if (!isUuid(id)) throw ticketRefusals.notFound();
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
   * customer's, another author's or another ticket's message, or with another body, is reused;
   * so is an opening's key with another type, link or subject (audit A07-23).
   */
  private async replay(
    db: Database | Transaction,
    customerId: string,
    idempotencyKey: string,
    body: string,
    target: string | TicketOpening,
  ): Promise<string | null> {
    const written = await messageByKey(db, idempotencyKey);
    if (!written) return null;
    if (
      written.customerId !== customerId ||
      written.author !== 'customer' ||
      written.body !== body ||
      (typeof target === 'string' ? written.ticketId !== target : !sameOpening(written, target))
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

  /**
   * The customer `FOR SHARE` before the ticket (audit A07-19): an archive that committed first
   * ended the session this request came with, so nothing is written.
   */
  private async lockCustomer(tx: Transaction, customerId: string): Promise<void> {
    const customer = await lockTicketCustomer(tx, customerId);
    if (!customer || customer.archived) {
      throw new CodedException(401, 'UNAUTHORIZED', 'Sign in first');
    }
  }

  /** TK1's refusals: the open and daily limits, the message rate, the link. */
  private async checkOpen(
    db: Database | Transaction,
    customerId: string,
    input: TicketOpening & { orderProblem?: OrderProblem | undefined },
  ): Promise<{ orderId: string | null; depositId: string | null }> {
    const ofCustomer = and(
      eq(supportTickets.customerId, customerId),
      eq(supportTickets.openedBy, 'customer'),
    );
    const [[open], [today]] = await readAll(db, [
      () =>
        db
          .select({ count: count() })
          .from(supportTickets)
          .where(and(ofCustomer, ne(supportTickets.status, 'closed'))),
      () =>
        db
          .select({ count: count() })
          .from(supportTickets)
          .where(and(ofCustomer, gt(supportTickets.createdAt, sql`now() - interval '24 hours'`))),
    ]);
    if ((open?.count ?? 0) >= TICKET_LIMITS.openPerCustomer) throw ticketRefusals.limit('open');
    if ((today?.count ?? 0) >= TICKET_LIMITS.createdPerDay) throw ticketRefusals.limit('daily');
    await this.checkMessageRate(db, customerId);
    return checkLink(db, customerId, input);
  }

  /** TK4, TK7's refusals of a customer message: the 7 days, the open limit on a reopen, the rate. */
  private async checkReply(
    db: Database | Transaction,
    customerId: string,
    ticket: TicketRow,
  ): Promise<void> {
    if (!customerCanReply(ticket, new Date())) throw ticketRefusals.closed();
    if (ticket.status === 'closed' && ticket.openedBy === 'customer') {
      const [open] = await db
        .select({ count: count() })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.customerId, customerId),
            eq(supportTickets.openedBy, 'customer'),
            ne(supportTickets.status, 'closed'),
          ),
        );
      if ((open?.count ?? 0) >= TICKET_LIMITS.openPerCustomer) throw ticketRefusals.limit('open');
    }
    await this.checkMessageRate(db, customerId);
  }

  /** TK7: 20 customer messages an hour, first messages included. */
  private async checkMessageRate(db: Database | Transaction, customerId: string): Promise<void> {
    const [row] = await db
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
        ...(kind === 'ticket_opened' &&
          ticket.orderProblem !== null && { orderProblem: ticket.orderProblem }),
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
