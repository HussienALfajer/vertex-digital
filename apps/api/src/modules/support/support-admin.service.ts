import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminCreateTicket,
  type AdminTicket,
  type AdminTicketListQuery,
  type AdminTicketPage,
  type CustomerStatus,
  customerStatus,
  type SupportSettings,
  TICKET_NOTICE_WINDOW_SECONDS,
  ticketNumberSchema,
  ticketTransition,
} from '@vertex-digital/contracts';
import {
  customerMarks,
  type Database,
  findCustomer,
  lockTicketCustomer,
  merchantsWith,
  merchantTier,
  merchantTiers,
  recordAudit,
  supportMessages,
  supportSettings,
  supportTickets,
  type Transaction,
  ticketDepositLink,
  ticketOrderLink,
} from '@vertex-digital/db';
import { and, asc, count, desc, eq, gt, inArray, min, or, type SQL, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AuthService, type DepositCustomer } from '../auth/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { NotificationsService } from '../notifications/index.js';
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

const statusOf = (customer: DepositCustomer): CustomerStatus =>
  customer.archived ? 'archived' : customer.frozen ? 'frozen' : 'active';

/** S23 OP2: the "بانتظار ردّك" cursor: priority, then the customer message time and id. */
const encodeWaitingCursor = (priority: boolean, at: string, id: string) =>
  Buffer.from(JSON.stringify(['w', priority, at, id])).toString('base64url');

function decodeWaitingCursor(cursor: string): { priority: boolean; at: string; id: string } {
  try {
    const [tag, priority, at, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown[];
    if (tag !== 'w' || typeof priority !== 'boolean' || typeof at !== 'string') throw new Error();
    if (typeof id !== 'string' || !isUuid(id) || Number.isNaN(Date.parse(at))) throw new Error();
    return { priority, at, id };
  } catch {
    throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid cursor', [
      { path: ['cursor'], message: 'Invalid cursor' },
    ]);
  }
}

function waitingPage<Row extends { ticket: { id: string }; cursorAt: string; isPriority: boolean }>(
  rows: Row[],
  limit: number,
): { items: Row[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeWaitingCursor(last.isPriority, last.cursorAt, last.ticket.id)
        : null,
  };
}

/**
 * The admin's support (S12 F23, rules TK2, TK3, TK5, TK9, TK11–TK13, SC1): the queue, the thread,
 * replies and closes, tickets opened to a customer, and the support settings. The admin has no
 * rate limit; every post carries an `Idempotency-Key`.
 */
@Injectable()
export class SupportAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly customers: AuthService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * `GET /api/admin/support/tickets` (TK12): "بانتظار ردّك" oldest customer message first; S23
   * OP2: there, tickets of merchants whose tier has support priority come first.
   */
  async queue(query: AdminTicketListQuery): Promise<AdminTicketPage> {
    const filters: (SQL | undefined)[] = [
      query.status === 'all' ? undefined : eq(supportTickets.status, query.status),
      query.category ? eq(supportTickets.category, query.category) : undefined,
      query.problem ? eq(supportTickets.orderProblem, query.problem) : undefined,
      query.customerId ? eq(supportTickets.customerId, query.customerId) : undefined,
    ];
    if (query.q) {
      const number = ticketNumberSchema.safeParse(query.q);
      if (!number.success)
        return { items: [], nextCursor: null, openCount: await this.openCount() };
      filters.push(eq(supportTickets.number, number.data));
    }
    const waiting = query.status === 'open';
    const time = waiting ? supportTickets.lastCustomerMessageAt : supportTickets.updatedAt;
    const priorityIds = waiting ? await merchantsWith(this.db, 'supportPriority') : [];
    // Never the constant `false`: PostgreSQL refuses a constant in `ORDER BY`.
    const priority =
      priorityIds.length === 0
        ? sql<boolean>`(${supportTickets.customerId} is null)`
        : sql<boolean>`${inArray(supportTickets.customerId, priorityIds)}`;
    if (query.cursor) {
      if (waiting) {
        const cursor = decodeWaitingCursor(query.cursor);
        const later = or(
          sql`${time} > ${cursor.at}::timestamptz`,
          and(sql`${time} = ${cursor.at}::timestamptz`, sql`${supportTickets.id} > ${cursor.id}`),
        );
        filters.push(
          cursor.priority
            ? or(sql`not ${priority}`, and(priority, later))
            : and(sql`not ${priority}`, later),
        );
      } else {
        filters.push(after(time, supportTickets.id, decodeCursor(query.cursor)));
      }
    }
    const rows = await this.db
      .select({
        ticket: supportTickets,
        // An open ticket always has a customer message: it is what made it open.
        cursorAt: cursorTime(time),
        isPriority: priority,
      })
      .from(supportTickets)
      .where(and(...filters))
      .orderBy(
        ...(waiting
          ? [desc(priority), asc(time), asc(supportTickets.id)]
          : [desc(time), desc(supportTickets.id)]),
      )
      .limit(query.limit + 1);
    const page = waiting
      ? waitingPage(rows, query.limit)
      : pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.ticket.id }));
    const customerIds = [...new Set(page.items.map((row) => row.ticket.customerId))];
    const [people, tiers] = await Promise.all([
      this.customers.depositCustomers(customerIds),
      merchantTiers(this.db, customerIds),
    ]);
    const summaries = await ticketSummaries(
      this.db,
      page.items.map(({ ticket }) => ticket),
    );
    const items = summaries.map((summary, index) => {
      const ticket = page.items[index]?.ticket;
      const customer = ticket && people.get(ticket.customerId);
      if (!customer) throw new Error(`Ticket ${summary.id} has no customer`);
      return {
        ...summary,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          status: statusOf(customer),
          tier: tiers.get(customer.id) ?? null,
        },
      };
    });
    return { items, nextCursor: page.nextCursor, openCount: await this.openCount() };
  }

  /** TK13: the navigation badge's count. */
  async openCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(supportTickets)
      .where(eq(supportTickets.status, 'open'));
    return row?.count ?? 0;
  }

  /** TK13: the dashboard's `tickets_waiting` line. */
  async waiting(): Promise<{ count: number; oldestAt: Date | null }> {
    const [row] = await this.db
      .select({ count: count(), oldestAt: min(supportTickets.lastCustomerMessageAt) })
      .from(supportTickets)
      .where(eq(supportTickets.status, 'open'));
    return { count: row?.count ?? 0, oldestAt: row?.oldestAt ?? null };
  }

  /** `GET /api/admin/support/tickets/:id`. */
  async ticket(id: string): Promise<AdminTicket> {
    if (!isUuid(id)) throw ticketRefusals.notFound();
    const [row] = await this.db.select().from(supportTickets).where(eq(supportTickets.id, id));
    if (!row) throw ticketRefusals.notFound();
    return this.view(row);
  }

  /** `POST /api/admin/support/tickets` (TK2): starts answered; the customer is told. */
  async open(
    adminId: string,
    idempotencyKey: string,
    input: AdminCreateTicket & { orderId?: string | undefined; depositId?: string | undefined },
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: AdminTicket; created: boolean }> {
    const replayed = await this.replay(this.db, idempotencyKey, input.body, input);
    if (replayed) return { ticket: await this.ticket(replayed), created: false };
    const found = await findCustomer(this.db, input.customerId);
    if (!found) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
    // Audit A07-1: a request sure to be refused stores no image; the transaction checks again.
    if (uploads.length > 0) {
      if (customerStatus(found) === 'archived') throw ticketRefusals.customerArchived();
      await checkLink(this.db, found.id, input);
    }
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const outcome = await this.db.transaction(async (tx) => {
      await this.lock(tx, idempotencyKey);
      const again = await this.replay(tx, idempotencyKey, input.body, input);
      if (again) return { id: again, created: false };
      // Audit A07-19: the status read under the customer's lock, not before the transaction.
      const customer = await lockTicketCustomer(tx, found.id);
      if (!customer) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
      if (customer.archived) throw ticketRefusals.customerArchived();
      const link = await checkLink(tx, customer.id, input);
      const ticket = await insertTicket(tx, {
        customerId: customer.id,
        category: input.category,
        ...link,
        subject: input.subject,
        status: 'answered',
        openedBy: 'admin',
        lastAdminMessageAt: sql`now()`,
      });
      const fileIds = [];
      for (const file of prepared) fileIds.push(await this.files.record(tx, file));
      await insertMessage(tx, {
        ticketId: ticket.id,
        author: 'admin',
        body: input.body,
        idempotencyKey,
        fileIds,
      });
      await recordAudit(tx, {
        ...this.entry(adminId, ticket.id, meta),
        action: 'ticket.opened_by_admin',
        details: { ...ticketChange(ticket, null), customerId: customer.id },
      });
      await this.notifyCustomer(tx, ticket, true);
      return { id: ticket.id, created: true };
    });
    return { ticket: await this.ticket(outcome.id), created: outcome.created };
  }

  /** `POST …/tickets/:id/messages` (TK3, TK5, TK9): reopens a closed ticket to answered. */
  async reply(
    adminId: string,
    id: string,
    idempotencyKey: string,
    body: string,
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: AdminTicket; created: boolean }> {
    // A light read, not the whole view with its signals: the answer builds that once (A07-21).
    if (!isUuid(id)) throw ticketRefusals.notFound();
    const [row] = await this.db
      .select({ customerId: supportTickets.customerId })
      .from(supportTickets)
      .where(eq(supportTickets.id, id));
    if (!row) throw ticketRefusals.notFound();
    if (await this.replay(this.db, idempotencyKey, body, id)) {
      return { ticket: await this.ticket(id), created: false };
    }
    // Q28 (audit A07-20): no reply reopens an archived customer's ticket or notifies them; checked
    // before the images are stored (A07-1) and again under the customer's lock (A07-19).
    const owner = await findCustomer(this.db, row.customerId);
    if (owner && customerStatus(owner) === 'archived') throw ticketRefusals.customerArchived();
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const created = await this.db.transaction(async (tx) => {
      await this.lock(tx, idempotencyKey);
      if (await this.replay(tx, idempotencyKey, body, id)) return false;
      const customer = await lockTicketCustomer(tx, row.customerId);
      if (customer?.archived) throw ticketRefusals.customerArchived();
      const ticket = await lockTicket(tx, id);
      if (!ticket) throw ticketRefusals.notFound();
      // TK9: the email at most once per ticket per 10 minutes; the center always.
      const [recent] = await tx
        .select({ count: count() })
        .from(supportMessages)
        .where(
          and(
            eq(supportMessages.ticketId, ticket.id),
            eq(supportMessages.author, 'admin'),
            gt(
              supportMessages.createdAt,
              sql`now() - make_interval(secs => ${TICKET_NOTICE_WINDOW_SECONDS})`,
            ),
          ),
        );
      const status = ticketTransition(ticket.status, 'admin_message') ?? ticket.status;
      const updated = await updateTicket(tx, ticket, {
        status,
        lastAdminMessageAt: sql`now()`,
        closedAt: null,
        closedBy: null,
      });
      const fileIds = [];
      for (const file of prepared) fileIds.push(await this.files.record(tx, file));
      const messageId = await insertMessage(tx, {
        ticketId: ticket.id,
        author: 'admin',
        body,
        idempotencyKey,
        fileIds,
      });
      await recordAudit(tx, {
        ...this.entry(adminId, ticket.id, meta),
        action: 'ticket.replied',
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
          ...this.entry(adminId, ticket.id, meta),
          action: 'ticket.reopened',
          details: ticketChange(updated, ticket.status),
        });
      }
      await this.notifyCustomer(tx, ticket, (recent?.count ?? 0) === 0);
      return true;
    });
    return { ticket: await this.ticket(id), created };
  }

  /** `POST …/tickets/:id/close`: a closed ticket is returned unchanged. */
  async close(adminId: string, id: string, meta: RequestMeta): Promise<AdminTicket> {
    if (!isUuid(id)) throw ticketRefusals.notFound();
    await this.db.transaction(async (tx) => {
      const ticket = await lockTicket(tx, id);
      if (!ticket) throw ticketRefusals.notFound();
      if (ticketTransition(ticket.status, 'close') === null) return;
      const closed = await updateTicket(tx, ticket, {
        status: 'closed',
        closedAt: sql`now()`,
        closedBy: 'admin',
      });
      await recordAudit(tx, {
        ...this.entry(adminId, ticket.id, meta),
        action: 'ticket.closed',
        details: { ...ticketChange(closed, ticket.status), cause: 'manual' },
      });
    });
    return this.ticket(id);
  }

  /** `GET /api/admin/support/tickets/:id/attachments/:fileId` (TK11). */
  async attachment(id: string, fileId: string): Promise<ServedFile> {
    const file =
      isUuid(id) && isUuid(fileId) && (await ticketHoldsFile(this.db, id, fileId))
        ? await this.files.serve(fileId, 'ticket_attachment')
        : null;
    if (!file) throw ticketRefusals.notFound();
    return file;
  }

  /** `GET /api/admin/support/settings` (SC1). */
  async settings(): Promise<SupportSettings> {
    const [row] = await this.db
      .select({ telegramUrl: supportSettings.telegramUrl })
      .from(supportSettings);
    return { telegramUrl: row?.telegramUrl ?? null };
  }

  /** `PUT /api/admin/support/settings` (SC1): audited with before and after. */
  async updateSettings(
    adminId: string,
    input: SupportSettings,
    meta: RequestMeta,
  ): Promise<SupportSettings> {
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ telegramUrl: supportSettings.telegramUrl })
        .from(supportSettings)
        .for('update');
      await tx
        .insert(supportSettings)
        .values({ id: 1, telegramUrl: input.telegramUrl })
        .onConflictDoUpdate({
          target: supportSettings.id,
          set: { telegramUrl: input.telegramUrl, updatedAt: sql`now()` },
        });
      await recordAudit(tx, {
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        action: 'support.settings_changed',
        entityType: 'support_settings',
        entityId: '00000000-0000-7000-8000-000000000001',
        details: {
          before: { telegramUrl: before?.telegramUrl ?? null },
          after: { telegramUrl: input.telegramUrl },
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    });
    return this.settings();
  }

  private async view(row: TicketRow): Promise<AdminTicket> {
    const [summary, messages, customer, marks, tier, order, deposit] = await Promise.all([
      ticketSummary(this.db, row),
      ticketMessages(this.db, row.id),
      findCustomer(this.db, row.customerId),
      customerMarks(this.db, row.customerId),
      merchantTier(this.db, row.customerId),
      row.orderId ? ticketOrderLink(this.db, row.orderId) : null,
      row.depositId ? ticketDepositLink(this.db, row.depositId) : null,
    ]);
    if (!customer) throw new Error(`Ticket ${row.id} has no customer`);
    return {
      ...summary,
      messages,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        status: customerStatus(customer),
        phone: customer.phone,
        isTest: customer.isTest,
        marks,
        tier,
      },
      orderSummary: order && {
        id: order.id,
        number: order.number,
        status: order.status,
        productNameAr: order.productNameAr,
        quantity: order.quantity,
        totalUsdUnits: order.totalUsdUnits,
        createdAt: order.createdAt.toISOString(),
      },
      depositSummary: deposit && {
        id: deposit.id,
        referenceCode: deposit.referenceCode,
        method: deposit.method,
        status: deposit.status,
        declaredUsdUnits: deposit.declaredUsdUnits,
        createdAt: deposit.createdAt.toISOString(),
      },
    };
  }

  /** TK9: `ticket_replied` in the center always; its email when `email` and the customer's choice. */
  private async notifyCustomer(tx: Transaction, ticket: TicketRow, email: boolean): Promise<void> {
    await this.notifications.notifyCustomer(
      tx,
      {
        customerId: ticket.customerId,
        event: 'ticket_replied',
        params: { ticketId: ticket.id, number: ticket.number },
      },
      { email },
    );
  }

  /** The ticket an admin `Idempotency-Key` already wrote, or null; another use is reused. */
  private async replay(
    db: Database | Transaction,
    idempotencyKey: string,
    body: string,
    target:
      | string
      | (AdminCreateTicket & { orderId?: string | undefined; depositId?: string | undefined }),
  ): Promise<string | null> {
    const written = await messageByKey(db, idempotencyKey);
    if (!written) return null;
    if (
      written.author !== 'admin' ||
      written.body !== body ||
      (typeof target === 'string'
        ? written.ticketId !== target
        : // Audit A07-23: an opening's key replays only the same customer, type, link and subject.
          written.customerId !== target.customerId ||
          written.category !== target.category ||
          written.orderId !== (target.orderId ?? null) ||
          written.depositId !== (target.depositId ?? null) ||
          written.subject !== target.subject)
    ) {
      throw ticketRefusals.keyReused();
    }
    return written.ticketId;
  }

  private async lock(tx: Transaction, idempotencyKey: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`support-key:${idempotencyKey}`}))`,
    );
  }

  private entry(adminId: string, ticketId: string, meta: RequestMeta) {
    return {
      actorKind: 'admin',
      actorId: adminId,
      channel: 'admin',
      entityType: 'support_ticket',
      entityId: ticketId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}
