import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateTicket,
  type CursorQuery,
  customerCanReply,
  type MerchantShopTicket,
  type MerchantShopTicketSummary,
  type OrderProblem,
  orderProblemAllowed,
  SHOP_TICKET_ESCALATION_HOURS,
  type ShopTicket,
  type ShopTicketSummary,
  type SupportMessageAuthor,
  shopTicketCustomerMayEscalate,
  TICKET_LIMITS,
  ticketLinkValid,
  ticketTransition,
} from '@vertex-digital/contracts';
import {
  type Database,
  lockShop,
  notifyShopCustomer,
  queueTelegramMessage,
  readAll,
  recordAudit,
  shopCustomerContacts,
  supportMessages,
  supportTickets,
  type Transaction,
  ticketOrderOf,
} from '@vertex-digital/db';
import { and, count, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { NotificationsService } from '../notifications/index.js';
import { type ShopCustomerIdentity, ShopsMerchantService } from '../shops/index.js';
import {
  insertMessage,
  insertTicket,
  isUuid,
  lockTicket,
  messageByKey,
  type TicketRow,
  threadMessages,
  ticketHoldsFile,
  ticketRefusals,
  ticketSummaries,
  updateTicket,
} from './support-records.js';

const HOUR_MS = 60 * 60 * 1000;

/** A shop customer's ticket: its shop and shop customer set (TK1). */
type ShopTicketRow = TicketRow & { shopId: string; shopCustomerId: string };

const isShopTicket = (row: TicketRow): row is ShopTicketRow =>
  row.shopId !== null && row.shopCustomerId !== null;

/** TK3: who the shop customer sees as the replier. */
const replier = (author: SupportMessageAuthor): 'customer' | 'shop' | 'support' =>
  author === 'customer' ? 'customer' : author === 'merchant' ? 'shop' : 'support';

type ShopOpening = Pick<CreateTicket, 'category' | 'subject' | 'body'> & {
  orderId?: string | undefined;
  orderProblem?: OrderProblem | undefined;
};

/**
 * Shop tickets (S26 TK1–TK5): a shop customer opens one from the shop and it goes to the shop's
 * merchant first; the merchant replies and may send it to the admin with a note, and the customer
 * may after 24 hours without a merchant reply (TK2). A ticket opened while the shop is closed goes
 * to the admin at once (edge case 15). Shop tickets keep S12's limits per shop customer (TK5) and
 * its images; every read is the shop customer's own, or the merchant's own shop's. The admin's
 * side of escalated tickets comes with the panel's shop screens (S26 PR 4).
 */
@Injectable()
export class SupportShopService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly shops: ShopsMerchantService,
  ) {}

  // --- The shop customer (TK1–TK3, TK5) ---

  /** `GET /api/shops/:slug/tickets`: newest activity first. */
  async list(customer: ShopCustomerIdentity, query: CursorQuery) {
    const rows = await this.db
      .select({ ticket: supportTickets, cursorAt: cursorTime(supportTickets.updatedAt) })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.shopCustomerId, customer.id),
          query.cursor
            ? after(supportTickets.updatedAt, supportTickets.id, decodeCursor(query.cursor))
            : undefined,
        ),
      )
      .orderBy(desc(supportTickets.updatedAt), desc(supportTickets.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.ticket.id }));
    return {
      items: await this.summaries(page.items.map((row) => row.ticket as ShopTicketRow)),
      nextCursor: page.nextCursor,
    };
  }

  /** `GET /api/shops/:slug/tickets/:id`. */
  async ticket(customer: ShopCustomerIdentity, id: string): Promise<ShopTicket> {
    const row = await this.ownTicket(this.db, customer, id);
    const [summary] = await this.summaries([row]);
    const now = new Date();
    return {
      ...(summary as ShopTicketSummary),
      canReply: customerCanReply(row, now),
      canEscalate: shopTicketCustomerMayEscalate(row, now),
      messages: await this.thread(row.id),
    };
  }

  /** `POST /api/shops/:slug/tickets` (TK1): the same key and body return the first ticket. */
  async open(
    customer: ShopCustomerIdentity,
    idempotencyKey: string,
    input: ShopOpening,
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: ShopTicket; created: boolean }> {
    const replayed = await this.replay(this.db, customer.id, idempotencyKey, input.body, input);
    if (replayed) return { ticket: await this.ticket(customer, replayed), created: false };
    if (uploads.length > 0) await this.checkOpen(this.db, customer, input);
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const outcome = await this.db.transaction(async (tx) => {
      await this.lock(tx, customer.id, idempotencyKey);
      const again = await this.replay(tx, customer.id, idempotencyKey, input.body, input);
      if (again) return { id: again, created: false };
      const shop = await this.lockShopOf(tx, customer);
      const orderId = await this.checkOpen(tx, customer, input);
      // Edge case 15: a closed shop's merchant answers nothing; the admin does.
      const escalate = shop.status === 'closed';
      const ticket = (await insertTicket(tx, {
        shopId: customer.shopId,
        shopCustomerId: customer.id,
        category: input.category,
        orderId,
        depositId: null,
        subject: input.subject,
        orderProblem: input.orderProblem ?? null,
        status: 'open',
        openedBy: 'customer',
        lastCustomerMessageAt: sql`now()`,
        escalatedAt: escalate ? sql`now()` : null,
      })) as ShopTicketRow;
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
        ...this.customerEntry(customer, ticket.id, meta),
        action: 'ticket.opened',
        details: {
          ticketId: ticket.id,
          category: ticket.category,
          before: null,
          after: ticket.status,
          ...(ticket.orderProblem !== null && { orderProblem: ticket.orderProblem }),
        },
      });
      if (escalate) {
        await this.escalated(tx, ticket, shop, 'system', null, meta);
      } else {
        await this.tellMerchant(tx, ticket, shop.merchantId, customer.name, 'opened');
      }
      return { id: ticket.id, created: true };
    });
    return { ticket: await this.ticket(customer, outcome.id), created: outcome.created };
  }

  /** `POST /api/shops/:slug/tickets/:id/messages` (TK3, TK4, TK5). */
  async reply(
    customer: ShopCustomerIdentity,
    id: string,
    idempotencyKey: string,
    body: string,
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: ShopTicket; created: boolean }> {
    const own = await this.ownTicket(this.db, customer, id);
    if (await this.replay(this.db, customer.id, idempotencyKey, body, id)) {
      return { ticket: await this.ticket(customer, id), created: false };
    }
    if (uploads.length > 0) await this.checkReply(this.db, customer, own);
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const created = await this.db.transaction(async (tx) => {
      await this.lock(tx, customer.id, idempotencyKey);
      if (await this.replay(tx, customer.id, idempotencyKey, body, id)) return false;
      const shop = await this.lockShopOf(tx, customer);
      const ticket = await lockTicket(tx, id);
      if (!ticket || ticket.shopCustomerId !== customer.id || !isShopTicket(ticket)) {
        throw ticketRefusals.notFound();
      }
      await this.checkReply(tx, customer, ticket);
      const updated = await updateTicket(tx, ticket, {
        status: ticketTransition(ticket.status, 'customer_message') ?? ticket.status,
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
        ...this.customerEntry(customer, ticket.id, meta),
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
      await this.tellMerchant(tx, ticket, shop.merchantId, customer.name, 'replied');
      return true;
    });
    return { ticket: await this.ticket(customer, id), created };
  }

  /** `POST /api/shops/:slug/tickets/:id/escalate` (TK2): after 24 hours without a reply. */
  async escalateByCustomer(
    customer: ShopCustomerIdentity,
    id: string,
    meta: RequestMeta,
  ): Promise<ShopTicket> {
    if (!isUuid(id)) throw ticketRefusals.notFound();
    await this.db.transaction(async (tx) => {
      const shop = await this.lockShopOf(tx, customer);
      const ticket = await lockTicket(tx, id);
      if (!ticket || ticket.shopCustomerId !== customer.id || !isShopTicket(ticket)) {
        throw ticketRefusals.notFound();
      }
      if (ticket.escalatedAt !== null) return;
      const now = new Date();
      if (!shopTicketCustomerMayEscalate(ticket, now)) {
        const asked = ticket.lastCustomerMessageAt ?? now;
        throw new CodedException(
          409,
          'TICKET_ESCALATION_TOO_EARLY',
          'The merchant has had less than 24 hours',
          {
            availableAt: new Date(
              asked.getTime() + SHOP_TICKET_ESCALATION_HOURS * HOUR_MS,
            ).toISOString(),
          },
        );
      }
      await this.escalated(tx, ticket, shop, 'shop_customer', null, meta, customer);
    });
    return this.ticket(customer, id);
  }

  /** `GET …/tickets/:id/attachments/:fileId`: an image of the customer's own ticket only. */
  async attachment(
    customer: ShopCustomerIdentity,
    id: string,
    fileId: string,
  ): Promise<ServedFile> {
    await this.ownTicket(this.db, customer, id);
    return this.served(id, fileId);
  }

  // --- The merchant (TK1–TK4) ---

  /** `GET /api/merchant/shop/tickets`: newest activity first, with the unanswered flag. */
  async merchantList(merchantId: string, query: CursorQuery) {
    const shop = await this.shops.readableShop(merchantId);
    const rows = await this.db
      .select({ ticket: supportTickets, cursorAt: cursorTime(supportTickets.updatedAt) })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.shopId, shop.id),
          query.cursor
            ? after(supportTickets.updatedAt, supportTickets.id, decodeCursor(query.cursor))
            : undefined,
        ),
      )
      .orderBy(desc(supportTickets.updatedAt), desc(supportTickets.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.ticket.id }));
    return {
      items: await this.merchantSummaries(page.items.map((row) => row.ticket as ShopTicketRow)),
      nextCursor: page.nextCursor,
    };
  }

  /** `GET /api/merchant/shop/tickets/:id` (TK4: the customer's name, email and phone). */
  async merchantTicket(merchantId: string, id: string): Promise<MerchantShopTicket> {
    const shop = await this.shops.readableShop(merchantId);
    const row = await this.shopTicket(this.db, shop.id, id);
    const [summary] = await this.merchantSummaries([row]);
    return {
      ...(summary as MerchantShopTicketSummary),
      canReply: row.status !== 'closed',
      messages: await this.thread(row.id),
    };
  }

  /** `POST /api/merchant/shop/tickets/:id/messages` (TK2, TK3). */
  async merchantReply(
    merchantId: string,
    id: string,
    idempotencyKey: string,
    body: string,
    uploads: readonly Buffer[],
    meta: RequestMeta,
  ): Promise<{ ticket: MerchantShopTicket; created: boolean }> {
    const shop = await this.shops.readableShop(merchantId);
    const own = await this.shopTicket(this.db, shop.id, id);
    if (own.status === 'closed') throw ticketRefusals.closed();
    const written = await messageByKey(this.db, idempotencyKey);
    if (written) {
      if (written.ticketId !== id || written.author !== 'merchant' || written.body !== body) {
        throw ticketRefusals.keyReused();
      }
      return { ticket: await this.merchantTicket(merchantId, id), created: false };
    }
    const prepared = await Promise.all(
      uploads.map((upload) => this.files.prepare('ticket_attachment', upload)),
    );
    const created = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`support-key:${idempotencyKey}`}))`,
      );
      const again = await messageByKey(tx, idempotencyKey);
      if (again) {
        if (again.ticketId !== id || again.author !== 'merchant' || again.body !== body) {
          throw ticketRefusals.keyReused();
        }
        return false;
      }
      const ticket = await lockTicket(tx, id);
      if (!ticket || ticket.shopId !== shop.id || !isShopTicket(ticket)) {
        throw ticketRefusals.notFound();
      }
      if (ticket.status === 'closed') throw ticketRefusals.closed();
      const updated = await updateTicket(tx, ticket, {
        status: ticketTransition(ticket.status, 'admin_message') ?? ticket.status,
        lastMerchantMessageAt: sql`now()`,
      });
      const fileIds = [];
      for (const file of prepared) fileIds.push(await this.files.record(tx, file));
      const messageId = await insertMessage(tx, {
        ticketId: ticket.id,
        author: 'merchant',
        body,
        idempotencyKey,
        fileIds,
      });
      await recordAudit(tx, {
        ...this.merchantEntry(merchantId, ticket.id, meta),
        action: 'ticket.merchant_replied',
        details: {
          ticketId: ticket.id,
          category: ticket.category,
          messageId,
          before: ticket.status,
          after: updated.status,
          images: fileIds.length,
        },
      });
      await notifyShopCustomer(tx, this.jobs, {
        shopCustomerId: ticket.shopCustomerId,
        event: 'ticket_replied',
        params: { ticketId: ticket.id, number: ticket.number, from: 'shop' },
      });
      return true;
    });
    return { ticket: await this.merchantTicket(merchantId, id), created };
  }

  /** `POST /api/merchant/shop/tickets/:id/escalate` (TK2): at any time, with a note. */
  async escalateByMerchant(
    merchantId: string,
    id: string,
    note: string,
    meta: RequestMeta,
  ): Promise<MerchantShopTicket> {
    const shop = await this.shops.readableShop(merchantId);
    await this.db.transaction(async (tx) => {
      const ticket = await lockTicket(tx, id);
      if (!ticket || ticket.shopId !== shop.id || !isShopTicket(ticket)) {
        throw ticketRefusals.notFound();
      }
      if (ticket.status === 'closed') throw ticketRefusals.closed();
      if (ticket.escalatedAt !== null) return;
      await this.escalated(tx, ticket, shop, 'merchant', note, meta);
    });
    return this.merchantTicket(merchantId, id);
  }

  /** `GET /api/merchant/shop/tickets/:id/attachments/:fileId`. */
  async merchantAttachment(merchantId: string, id: string, fileId: string): Promise<ServedFile> {
    const shop = await this.shops.readableShop(merchantId);
    await this.shopTicket(this.db, shop.id, id);
    return this.served(id, fileId);
  }

  // --- Shared ---

  /**
   * TK2: the escalation, once: `escalated_at`, the audit entry (the merchant's note as its
   * reason), the admin's Telegram notice and, by the customer, the merchant's notification.
   */
  private async escalated(
    tx: Transaction,
    ticket: ShopTicketRow,
    shop: { id: string; slug: string; merchantId: string },
    by: 'merchant' | 'shop_customer' | 'system',
    note: string | null,
    meta: RequestMeta,
    customer?: ShopCustomerIdentity,
  ): Promise<void> {
    if (ticket.escalatedAt === null) {
      await updateTicket(tx, ticket, { escalatedAt: sql`now()` });
    }
    await recordAudit(tx, {
      ...(by === 'merchant'
        ? this.merchantEntry(shop.merchantId, ticket.id, meta)
        : by === 'shop_customer' && customer
          ? this.customerEntry(customer, ticket.id, meta)
          : {
              actorKind: 'system' as const,
              actorId: null,
              channel: 'store' as const,
              entityType: 'support_ticket' as const,
              entityId: ticket.id,
            }),
      action: 'ticket.escalated',
      reason: note,
      details: { ticketId: ticket.id, category: ticket.category, by },
    });
    await queueTelegramMessage(tx, this.jobs, {
      kind: 'shop_ticket_escalated',
      params: {
        ticketId: ticket.id,
        number: ticket.number,
        slug: shop.slug,
        by: by === 'shop_customer' ? 'customer' : by,
      },
      dedupeKey: `shop-ticket:${ticket.id}:escalated`,
    });
    if (by === 'shop_customer' && customer) {
      await this.tellMerchant(tx, ticket, shop.merchantId, customer.name, 'escalated');
    }
  }

  /** TK1: the merchant's notification center and push, never the message. */
  private async tellMerchant(
    tx: Transaction,
    ticket: ShopTicketRow,
    merchantId: string,
    customerName: string,
    kind: 'opened' | 'replied' | 'escalated',
  ): Promise<void> {
    await this.notifications.notifyCustomer(tx, {
      customerId: merchantId,
      event: 'merchant_shop_ticket',
      params: { ticketId: ticket.id, number: ticket.number, customerName, kind },
    });
  }

  /** The customer's shop `FOR SHARE` (its state read for edge case 15). */
  private lockShopOf(tx: Transaction, customer: ShopCustomerIdentity) {
    return lockShop(tx, customer.shopId, 'share');
  }

  private async ownTicket(
    db: Database | Transaction,
    customer: ShopCustomerIdentity,
    id: string,
  ): Promise<ShopTicketRow> {
    if (!isUuid(id)) throw ticketRefusals.notFound();
    const [row] = await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, id), eq(supportTickets.shopCustomerId, customer.id)));
    if (!row || !isShopTicket(row)) throw ticketRefusals.notFound();
    return row;
  }

  private async shopTicket(
    db: Database | Transaction,
    shopId: string,
    id: string,
  ): Promise<ShopTicketRow> {
    if (!isUuid(id)) throw ticketRefusals.notFound();
    const [row] = await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, id), eq(supportTickets.shopId, shopId)));
    if (!row || !isShopTicket(row)) throw ticketRefusals.notFound();
    return row;
  }

  private async served(ticketId: string, fileId: string): Promise<ServedFile> {
    const file =
      isUuid(fileId) && (await ticketHoldsFile(this.db, ticketId, fileId))
        ? await this.files.serve(fileId, 'ticket_attachment')
        : null;
    if (!file) throw ticketRefusals.notFound();
    return file;
  }

  private async thread(ticketId: string) {
    return (await threadMessages(this.db, ticketId)).map(({ author, ...message }) => ({
      ...message,
      from: replier(author),
    }));
  }

  /** The customer's view of rows (TK3): the last replier and the escalation. */
  private async summaries(rows: readonly ShopTicketRow[]): Promise<ShopTicketSummary[]> {
    const base = await ticketSummaries(this.db, rows);
    return base.map(({ deposit, openedBy, lastAuthor, ...summary }, index) => {
      const row = rows[index] as ShopTicketRow;
      const customerAt = row.lastCustomerMessageAt?.getTime() ?? 0;
      const merchantAt = row.lastMerchantMessageAt?.getTime() ?? 0;
      const adminAt = row.lastAdminMessageAt?.getTime() ?? 0;
      const latest = Math.max(customerAt, merchantAt, adminAt);
      return {
        ...summary,
        lastReplier:
          latest === customerAt ? 'customer' : latest === merchantAt ? 'shop' : 'support',
        lastMessageAt: new Date(Math.max(latest, row.createdAt.getTime())).toISOString(),
        escalatedAt: row.escalatedAt?.toISOString() ?? null,
      };
    });
  }

  /** TK4: the merchant's view: the customer and the unanswered flag. */
  private async merchantSummaries(
    rows: readonly ShopTicketRow[],
  ): Promise<MerchantShopTicketSummary[]> {
    const summaries = await this.summaries(rows);
    const byId = await shopCustomerContacts(this.db, [
      ...new Set(rows.map((row) => row.shopCustomerId)),
    ]);
    return summaries.map((summary, index) => {
      const row = rows[index] as ShopTicketRow;
      const customer = byId.get(row.shopCustomerId);
      if (!customer) throw new Error(`Ticket ${row.id} has no shop customer`);
      return {
        ...summary,
        customer,
        unanswered: row.status === 'open',
      };
    });
  }

  /** The ticket an `Idempotency-Key` wrote for this shop customer, or null (S12's replay). */
  private async replay(
    db: Database | Transaction,
    shopCustomerId: string,
    idempotencyKey: string,
    body: string,
    target: string | ShopOpening,
  ): Promise<string | null> {
    const written = await messageByKey(db, idempotencyKey);
    if (!written) return null;
    const [ticket] = await db
      .select({ shopCustomerId: supportTickets.shopCustomerId })
      .from(supportTickets)
      .where(eq(supportTickets.id, written.ticketId));
    if (
      ticket?.shopCustomerId !== shopCustomerId ||
      written.author !== 'customer' ||
      written.body !== body ||
      (typeof target === 'string'
        ? written.ticketId !== target
        : written.category !== target.category ||
          written.orderId !== (target.orderId ?? null) ||
          written.subject !== target.subject)
    ) {
      throw ticketRefusals.keyReused();
    }
    return written.ticketId;
  }

  private async lock(tx: Transaction, shopCustomerId: string, idempotencyKey: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`support-key:${idempotencyKey}`}))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`support:shop:${shopCustomerId}`}))`,
    );
  }

  /** TK1, TK5: S12's limits per shop customer, and the link to the customer's own shop order. */
  private async checkOpen(
    db: Database | Transaction,
    customer: ShopCustomerIdentity,
    input: ShopOpening,
  ): Promise<string | null> {
    if (input.category === 'deposit' || !ticketLinkValid(input)) {
      throw ticketRefusals.linkInvalid();
    }
    const mine = eq(supportTickets.shopCustomerId, customer.id);
    const [[open], [today]] = await readAll(db, [
      () =>
        db
          .select({ count: count() })
          .from(supportTickets)
          .where(and(mine, ne(supportTickets.status, 'closed'))),
      () =>
        db
          .select({ count: count() })
          .from(supportTickets)
          .where(and(mine, gt(supportTickets.createdAt, sql`now() - interval '24 hours'`))),
    ]);
    if ((open?.count ?? 0) >= TICKET_LIMITS.openPerCustomer) throw ticketRefusals.limit('open');
    if ((today?.count ?? 0) >= TICKET_LIMITS.createdPerDay) throw ticketRefusals.limit('daily');
    await this.checkMessageRate(db, customer.id);
    if (!input.orderId) return null;
    const order = await ticketOrderOf(db, input.orderId, { shopCustomerId: customer.id });
    if (!order) throw ticketRefusals.linkInvalid();
    const refusal =
      input.orderProblem && orderProblemAllowed(order, input.orderProblem, new Date());
    if (refusal) throw ticketRefusals.problemUnavailable(refusal);
    const [already] = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(and(eq(supportTickets.orderId, order.id), ne(supportTickets.status, 'closed')));
    if (already) throw ticketRefusals.alreadyOpen(already.id);
    return order.id;
  }

  private async checkReply(
    db: Database | Transaction,
    customer: ShopCustomerIdentity,
    ticket: ShopTicketRow,
  ): Promise<void> {
    if (!customerCanReply(ticket, new Date())) throw ticketRefusals.closed();
    await this.checkMessageRate(db, customer.id);
  }

  /** TK5 (S12 TK7): 20 customer messages an hour. */
  private async checkMessageRate(db: Database | Transaction, shopCustomerId: string) {
    const [row] = await db
      .select({ count: count() })
      .from(supportMessages)
      .innerJoin(supportTickets, eq(supportTickets.id, supportMessages.ticketId))
      .where(
        and(
          eq(supportTickets.shopCustomerId, shopCustomerId),
          eq(supportMessages.author, 'customer'),
          gt(supportMessages.createdAt, new Date(Date.now() - HOUR_MS)),
        ),
      );
    if ((row?.count ?? 0) >= TICKET_LIMITS.messagesPerHour) {
      throw new CodedException(429, 'RATE_LIMITED', 'Too many messages, try later');
    }
  }

  private customerEntry(customer: ShopCustomerIdentity, ticketId: string, meta: RequestMeta) {
    return {
      actorKind: 'shop_customer',
      actorId: customer.id,
      channel: 'store',
      entityType: 'support_ticket',
      entityId: ticketId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }

  private merchantEntry(merchantId: string, ticketId: string, meta: RequestMeta) {
    return {
      actorKind: 'customer',
      actorId: merchantId,
      channel: 'store',
      entityType: 'support_ticket',
      entityId: ticketId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}
