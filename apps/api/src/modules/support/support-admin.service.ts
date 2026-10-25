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
  recordAudit,
  supportMessages,
  supportSettings,
  supportTickets,
  type Transaction,
  ticketDepositLink,
  ticketOrderLink,
} from '@vertex-digital/db';
import { and, asc, count, desc, eq, gt, min, or, type SQL, sql } from 'drizzle-orm';
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
  ticketSummary,
  updateTicket,
} from './support-records.js';

const statusOf = (customer: DepositCustomer): CustomerStatus =>
  customer.archived ? 'archived' : customer.frozen ? 'frozen' : 'active';

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

  /** `GET /api/admin/support/tickets` (TK12): "بانتظار ردّك" oldest customer message first. */
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
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      filters.push(
        waiting
          ? or(
              sql`${time} > ${cursor.at}::timestamptz`,
              and(
                sql`${time} = ${cursor.at}::timestamptz`,
                sql`${supportTickets.id} > ${cursor.id}`,
              ),
            )
          : after(time, supportTickets.id, cursor),
      );
    }
    const rows = await this.db
      .select({
        ticket: supportTickets,
        // An open ticket always has a customer message: it is what made it open.
        cursorAt: cursorTime(time),
      })
      .from(supportTickets)
      .where(and(...filters))
      .orderBy(
        waiting ? asc(time) : desc(time),
        waiting ? asc(supportTickets.id) : desc(supportTickets.id),
      )
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.ticket.id }));
    const people = await this.customers.depositCustomers([
      ...new Set(page.items.map((row) => row.ticket.customerId)),
    ]);
    const items = await Promise.all(
      page.items.map(async ({ ticket }) => {
        const customer = people.get(ticket.customerId);
        if (!customer) throw new Error(`Ticket ${ticket.id} has no customer`);
        return {
          ...(await ticketSummary(this.db, ticket)),
          customer: {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            status: statusOf(customer),
          },
        };
      }),
    );
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
    const replayed = await this.replay(this.db, idempotencyKey, input.body, null);
    if (replayed) return { ticket: await this.ticket(replayed), created: false };
    const customer = await findCustomer(this.db, input.customerId);
    if (!customer) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const outcome = await this.db.transaction(async (tx) => {
      await this.lock(tx, idempotencyKey);
      const again = await this.replay(tx, idempotencyKey, input.body, null);
      if (again) return { id: again, created: false };
      const status = customerStatus(customer);
      if (status === 'archived') {
        throw new CodedException(409, 'CUSTOMER_STATE_INVALID', 'The customer is archived', {
          status,
        });
      }
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
    await this.ticket(id);
    if (await this.replay(this.db, idempotencyKey, body, id)) {
      return { ticket: await this.ticket(id), created: false };
    }
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const created = await this.db.transaction(async (tx) => {
      await this.lock(tx, idempotencyKey);
      if (await this.replay(tx, idempotencyKey, body, id)) return false;
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
    const [summary, messages, customer, marks, order, deposit] = await Promise.all([
      ticketSummary(this.db, row),
      ticketMessages(this.db, row.id),
      findCustomer(this.db, row.customerId),
      customerMarks(this.db, row.customerId),
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
    ticketId: string | null,
  ): Promise<string | null> {
    const written = await messageByKey(db, idempotencyKey);
    if (!written) return null;
    if (
      written.author !== 'admin' ||
      written.body !== body ||
      (ticketId !== null && written.ticketId !== ticketId)
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
