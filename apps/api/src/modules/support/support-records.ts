import { randomInt } from 'node:crypto';
import {
  TICKET_NUMBER_ALPHABET,
  TICKET_NUMBER_LENGTH,
  TICKET_NUMBER_PREFIX,
  type TicketAuthor,
  type TicketCategory,
  type TicketMessage,
  type TicketSummary,
  ticketLinkValid,
} from '@vertex-digital/contracts';
import {
  type Database,
  newId,
  readAll,
  supportAttachments,
  supportMessages,
  supportTickets,
  type Transaction,
  ticketDepositLink,
  ticketOrderLink,
} from '@vertex-digital/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';

/*
 * Rows and refusals shared by the customer's and the admin's ticket routes (S12 TK1–TK12).
 */

export type TicketRow = typeof supportTickets.$inferSelect;

type Executor = Database | Transaction;

export const isUuid = (value: string) => z.uuid().safeParse(value).success;

export const ticketRefusals = {
  notFound: () => new CodedException(404, 'NOT_FOUND', 'No such ticket'),
  linkInvalid: () =>
    new CodedException(400, 'TICKET_LINK_INVALID', 'The ticket link does not fit its type'),
  alreadyOpen: (ticketId: string) =>
    new CodedException(409, 'TICKET_ALREADY_OPEN', 'The order or deposit has an open ticket', {
      ticketId,
    }),
  limit: (limit: 'open' | 'daily') =>
    new CodedException(409, 'TICKETS_LIMIT_REACHED', 'Too many tickets', { limit }),
  closed: () => new CodedException(409, 'TICKET_CLOSED', 'The ticket closed more than 7 days ago'),
  keyReused: () =>
    new CodedException(409, 'IDEMPOTENCY_KEY_REUSED', 'The key was used for another message'),
};

/** Attempts at a free ticket number: 31⁶ numbers make a second attempt already rare. */
const NUMBER_ATTEMPTS = 5;

const newTicketNumber = () =>
  `${TICKET_NUMBER_PREFIX}${Array.from(
    { length: TICKET_NUMBER_LENGTH },
    () => TICKET_NUMBER_ALPHABET[randomInt(TICKET_NUMBER_ALPHABET.length)],
  ).join('')}`;

/** The ticket holding the open slot of an order or a deposit (TK1), or null. */
async function openTicketFor(
  db: Executor,
  link: { orderId: string | null; depositId: string | null },
): Promise<string | null> {
  const condition = link.orderId
    ? eq(supportTickets.orderId, link.orderId)
    : link.depositId
      ? eq(supportTickets.depositId, link.depositId)
      : undefined;
  if (!condition) return null;
  const [row] = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(condition, ne(supportTickets.status, 'closed')));
  return row?.id ?? null;
}

/**
 * Rule TK1: the link fits the type and is the customer's own; `TICKET_LINK_INVALID` otherwise.
 * `TICKET_ALREADY_OPEN` when the order or deposit already has a ticket that is not closed.
 */
export async function checkLink(
  db: Executor,
  customerId: string,
  link: { category: TicketCategory; orderId?: string | undefined; depositId?: string | undefined },
): Promise<{ orderId: string | null; depositId: string | null }> {
  if (!ticketLinkValid(link)) throw ticketRefusals.linkInvalid();
  const orderId = link.orderId ?? null;
  const depositId = link.depositId ?? null;
  if (orderId) {
    const order = await ticketOrderLink(db, orderId);
    if (order?.customerId !== customerId) throw ticketRefusals.linkInvalid();
  }
  if (depositId) {
    const deposit = await ticketDepositLink(db, depositId);
    if (deposit?.customerId !== customerId) throw ticketRefusals.linkInvalid();
  }
  const open = await openTicketFor(db, { orderId, depositId });
  if (open) throw ticketRefusals.alreadyOpen(open);
  return { orderId, depositId };
}

/** Inserts a ticket, drawing another number on the rare collision; a lost race is `TICKET_ALREADY_OPEN`. */
export async function insertTicket(
  tx: Transaction,
  values: Omit<PgInsertValue<typeof supportTickets>, 'id' | 'number' | 'orderId' | 'depositId'> & {
    orderId: string | null;
    depositId: string | null;
  },
): Promise<TicketRow> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // A savepoint: a collision leaves the transaction usable for the next attempt.
      const [row] = await tx.transaction((step) =>
        step
          .insert(supportTickets)
          .values({ ...values, id: newId(), number: newTicketNumber() })
          .returning(),
      );
      if (!row) throw new Error('The ticket was not written');
      return row;
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (
        constraint === 'support_tickets_open_order_idx' ||
        constraint === 'support_tickets_open_deposit_idx'
      ) {
        const open = await openTicketFor(tx, {
          orderId: values.orderId,
          depositId: values.depositId,
        });
        throw ticketRefusals.alreadyOpen(open ?? '');
      }
      if (constraint !== 'support_tickets_number_unique' || attempt >= NUMBER_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/**
 * Changes a locked ticket's status in a savepoint: a reopening that meets another open ticket of
 * the same order or deposit answers `TICKET_ALREADY_OPEN` (TK4, TK5).
 */
export async function updateTicket(
  tx: Transaction,
  ticket: TicketRow,
  values: PgUpdateSetSource<typeof supportTickets>,
): Promise<TicketRow> {
  try {
    const [row] = await tx.transaction((step) =>
      step
        .update(supportTickets)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(supportTickets.id, ticket.id))
        .returning(),
    );
    if (!row) throw new Error(`Ticket ${ticket.id} vanished under its lock`);
    return row;
  } catch (error) {
    const constraint = violatedConstraint(error);
    if (
      constraint === 'support_tickets_open_order_idx' ||
      constraint === 'support_tickets_open_deposit_idx'
    ) {
      const open = await openTicketFor(tx, {
        orderId: ticket.orderId,
        depositId: ticket.depositId,
      });
      throw ticketRefusals.alreadyOpen(open ?? '');
    }
    throw error;
  }
}

/** Writes a message and its images in their order (TK7, TK11). */
export async function insertMessage(
  tx: Transaction,
  input: {
    ticketId: string;
    author: TicketAuthor;
    body: string;
    idempotencyKey: string;
    fileIds: readonly string[];
  },
): Promise<string> {
  const id = newId();
  await tx.insert(supportMessages).values({
    id,
    ticketId: input.ticketId,
    author: input.author,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
  });
  if (input.fileIds.length > 0) {
    await tx
      .insert(supportAttachments)
      .values(
        input.fileIds.map((fileId, index) => ({ messageId: id, fileId, position: index + 1 })),
      );
  }
  return id;
}

/** The message an `Idempotency-Key` already wrote, with its ticket, or null. */
export async function messageByKey(db: Executor, idempotencyKey: string) {
  const [row] = await db
    .select({
      id: supportMessages.id,
      author: supportMessages.author,
      body: supportMessages.body,
      ticketId: supportMessages.ticketId,
      customerId: supportTickets.customerId,
    })
    .from(supportMessages)
    .innerJoin(supportTickets, eq(supportTickets.id, supportMessages.ticketId))
    .where(eq(supportMessages.idempotencyKey, idempotencyKey));
  return row ?? null;
}

/** The ticket `FOR UPDATE`, or null. */
export async function lockTicket(tx: Transaction, id: string): Promise<TicketRow | null> {
  const [row] = await tx
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.id, id))
    .for('update');
  return row ?? null;
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** A ticket as the lists show it (TK12). */
export async function ticketSummary(db: Executor, row: TicketRow): Promise<TicketSummary> {
  const [order, deposit] = await readAll(db, [
    () => (row.orderId ? ticketOrderLink(db, row.orderId) : null),
    () => (row.depositId ? ticketDepositLink(db, row.depositId) : null),
  ]);
  const customerAt = row.lastCustomerMessageAt?.getTime() ?? 0;
  const adminAt = row.lastAdminMessageAt?.getTime() ?? 0;
  return {
    id: row.id,
    number: row.number,
    category: row.category,
    order: order && { id: order.id, number: order.number },
    deposit: deposit && { id: deposit.id, referenceCode: deposit.referenceCode },
    subject: row.subject,
    status: row.status,
    openedBy: row.openedBy,
    lastAuthor: adminAt > customerAt ? 'admin' : 'customer',
    lastMessageAt: new Date(Math.max(customerAt, adminAt, row.createdAt.getTime())).toISOString(),
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The thread, oldest first, with each message's images in their order (TK12). */
export async function ticketMessages(db: Executor, ticketId: string): Promise<TicketMessage[]> {
  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.ticketId, ticketId))
    .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
  const attachments =
    messages.length === 0
      ? []
      : await db
          .select()
          .from(supportAttachments)
          .where(
            inArray(
              supportAttachments.messageId,
              messages.map((message) => message.id),
            ),
          )
          .orderBy(asc(supportAttachments.position));
  return messages.map((message) => ({
    id: message.id,
    author: message.author,
    body: message.body,
    attachments: attachments
      .filter((attachment) => attachment.messageId === message.id)
      .map((attachment) => attachment.fileId),
    createdAt: message.createdAt.toISOString(),
  }));
}

/** Whether the file is an image of a message of this ticket (TK11). */
export async function ticketHoldsFile(
  db: Executor,
  ticketId: string,
  fileId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ fileId: supportAttachments.fileId })
    .from(supportAttachments)
    .innerJoin(supportMessages, eq(supportMessages.id, supportAttachments.messageId))
    .where(and(eq(supportMessages.ticketId, ticketId), eq(supportAttachments.fileId, fileId)));
  return row !== undefined;
}

/** The audit details of a status change (AU1): ids, the category, the statuses; never a body. */
export const ticketChange = (ticket: TicketRow, before: TicketRow['status'] | null) => ({
  ticketId: ticket.id,
  category: ticket.category,
  before,
  after: ticket.status,
});
