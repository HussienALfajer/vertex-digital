import { z } from 'zod';
import { customerMarksSchema, customerStatusSchema } from './customer-status.js';
import {
  depositMethodSchema,
  depositStatusSchema,
  REFERENCE_CODE_ALPHABET,
  UPLOAD_MAX_BYTES,
} from './deposits.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { amountUnitsSchema } from './money.js';
import { orderStatusSchema } from './orders.js';

/*
 * Support tickets and the support channels (S12 F23, owner 2026-10-10), owned by the api `support`
 * module: a customer or the admin opens a ticket of a type, linked to one of the customer's orders
 * or deposits when it is about one; messages are plain text with up to 3 images.
 */

export const TICKET_CATEGORIES = ['order', 'deposit', 'account', 'other'] as const;

export const ticketCategorySchema = z.enum(TICKET_CATEGORIES).meta({ id: 'TicketCategory' });

export type TicketCategory = z.infer<typeof ticketCategorySchema>;

/** `open`: waiting for the admin; `answered`: waiting for the customer (rule TK3). */
export const TICKET_STATUSES = ['open', 'answered', 'closed'] as const;

export const ticketStatusSchema = z.enum(TICKET_STATUSES).meta({ id: 'TicketStatus' });

export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const TICKET_AUTHORS = ['customer', 'admin'] as const;

export const ticketAuthorSchema = z.enum(TICKET_AUTHORS).meta({ id: 'TicketAuthor' });

export type TicketAuthor = z.infer<typeof ticketAuthorSchema>;

export const TICKET_CLOSERS = ['customer', 'admin', 'system'] as const;

export const ticketCloserSchema = z.enum(TICKET_CLOSERS).meta({ id: 'TicketCloser' });

export type TicketCloser = z.infer<typeof ticketCloserSchema>;

/** The spec's limits (TK1, TK4, TK6, TK7, TK11). */
export const TICKET_LIMITS = {
  /** Non-closed tickets the customer opened. */
  openPerCustomer: 3,
  /** Tickets the customer opened in the last 24 hours. */
  createdPerDay: 5,
  /** Customer messages an hour, first messages included. */
  messagesPerHour: 20,
  imagesPerMessage: 3,
  imageMaxBytes: UPLOAD_MAX_BYTES,
  /** Days without a customer answer before an answered ticket closes, and to reopen a closed one. */
  autoCloseDays: 7,
  reopenDays: 7,
} as const;

/** Telegram `ticket_reply` and the `ticket_replied` email: at most one per ticket per window (TK8, TK9). */
export const TICKET_NOTICE_WINDOW_SECONDS = 10 * 60;

/** The key that groups a ticket's notices into one per 10-minute window (TK8, TK9). */
export function ticketNoticeKey(ticketId: string, at: Date): string {
  const bucket = Math.floor(at.getTime() / (TICKET_NOTICE_WINDOW_SECONDS * 1000));
  return `ticket:${ticketId}:${bucket}`;
}

/* Numbers --------------------------------------------------------------------------------- */

/** Ticket numbers: `VT-` and 6 characters of the order number alphabet. */
export const TICKET_NUMBER_ALPHABET = REFERENCE_CODE_ALPHABET;
export const TICKET_NUMBER_LENGTH = 6;
export const TICKET_NUMBER_PREFIX = 'VT-';

const TICKET_NUMBER_PATTERN = new RegExp(
  `^${TICKET_NUMBER_PREFIX}[${TICKET_NUMBER_ALPHABET}]{${TICKET_NUMBER_LENGTH}}$`,
);

/** A ticket number as typed: lower case and a missing dash are accepted, `VT-XXXXXX` returned. */
export const ticketNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/^VT-?/, TICKET_NUMBER_PREFIX))
  .pipe(z.string().regex(TICKET_NUMBER_PATTERN, 'Expected a ticket number such as VT-7KQ2MX'));

/* Rules ----------------------------------------------------------------------------------- */

export type TicketEvent = 'customer_message' | 'admin_message' | 'close';

/**
 * Rules TK3–TK5: the status after an event, or null when nothing changes (closing a closed
 * ticket). A customer message on a closed ticket also needs `customerCanReply`.
 */
export function ticketTransition(status: TicketStatus, event: TicketEvent): TicketStatus | null {
  if (event === 'customer_message') return 'open';
  if (event === 'admin_message') return 'answered';
  return status === 'closed' ? null : 'closed';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rule TK4: a closed ticket takes a customer message within 7 days of its closing. */
export function customerCanReply(
  ticket: { status: TicketStatus; closedAt: Date | null },
  now: Date,
): boolean {
  if (ticket.status !== 'closed' || ticket.closedAt === null) return true;
  return now.getTime() - ticket.closedAt.getTime() <= TICKET_LIMITS.reopenDays * DAY_MS;
}

/** Rule TK6: an answered ticket whose last admin message is older than this closes. */
export function autoCloseBefore(now: Date): Date {
  return new Date(now.getTime() - TICKET_LIMITS.autoCloseDays * DAY_MS);
}

/** Rule TK1: an order ticket names an order, a deposit ticket a deposit, the others neither. */
export function ticketLinkValid(link: {
  category: TicketCategory;
  orderId?: string | null | undefined;
  depositId?: string | null | undefined;
}): boolean {
  const order = link.orderId != null;
  const deposit = link.depositId != null;
  if (link.category === 'order') return order && !deposit;
  if (link.category === 'deposit') return deposit && !order;
  return !order && !deposit;
}

/* Inputs ---------------------------------------------------------------------------------- */

/** 3 to 120 characters after trimming, one line, no control characters. */
export const ticketSubjectSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[^\p{Cc}]+$/u);

/** 1 to 2000 characters after trimming; new lines kept, no other control characters (TK7). */
export const ticketBodySchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(2000)
      .regex(/^(?:[^\p{Cc}]|\n)+$/u),
  );

/** Multipart fields arrive as strings; an empty id means none. */
const optionalId = z.preprocess((value) => (value === '' ? undefined : value), z.uuid().optional());

const ticketFields = {
  category: ticketCategorySchema,
  orderId: optionalId,
  depositId: optionalId,
  subject: ticketSubjectSchema,
  body: ticketBodySchema,
};

/** `POST /api/support/tickets` (rule TK1), with up to 3 images as `files`. */
export const createTicketSchema = z.object(ticketFields).meta({ id: 'CreateTicket' });

export type CreateTicket = z.input<typeof createTicketSchema>;

/** `POST /api/admin/support/tickets` (rule TK2), with up to 3 images as `files`. */
export const adminCreateTicketSchema = z
  .object({ ...ticketFields, customerId: z.uuid() })
  .meta({ id: 'AdminCreateTicket' });

export type AdminCreateTicket = z.input<typeof adminCreateTicketSchema>;

/** `POST …/tickets/:id/messages` (rule TK7), with up to 3 images as `files`. */
export const ticketMessageSchema = z
  .object({ body: ticketBodySchema })
  .meta({ id: 'TicketMessageInput' });

export type TicketMessageInput = z.input<typeof ticketMessageSchema>;

/* Outputs --------------------------------------------------------------------------------- */

const ticketMessage = z
  .object({
    id: z.uuid(),
    author: ticketAuthorSchema,
    body: z.string(),
    /** The images in their order; served by the ticket's attachment route. */
    attachments: z.array(z.uuid()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'TicketMessage' });

export type TicketMessage = z.infer<typeof ticketMessage>;

const ticketSummary = {
  id: z.uuid(),
  number: z.string(),
  category: ticketCategorySchema,
  order: z.object({ id: z.uuid(), number: z.string() }).nullable(),
  deposit: z.object({ id: z.uuid(), referenceCode: z.string() }).nullable(),
  subject: z.string(),
  status: ticketStatusSchema,
  openedBy: ticketAuthorSchema,
  /** Who wrote the last message: the store shows a dot when it is the admin (TK12). */
  lastAuthor: ticketAuthorSchema,
  lastMessageAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  closedBy: ticketCloserSchema.nullable(),
  createdAt: z.iso.datetime(),
};

/** One row of the customer's list (TK12). */
export const ticketSummarySchema = z.object(ticketSummary).meta({ id: 'TicketSummary' });

export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/** `GET /api/support/tickets/:id`: the thread, oldest message first. */
export const ticketSchema = z
  .object({
    ...ticketSummary,
    /** Rule TK4: false once a closed ticket is past 7 days; the page offers a new ticket. */
    canReply: z.boolean(),
    messages: z.array(ticketMessage),
  })
  .meta({ id: 'Ticket' });

export type Ticket = z.infer<typeof ticketSchema>;

export const ticketListQuerySchema = cursorQuerySchema
  .extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .meta({ id: 'TicketListQuery' });

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketPageSchema = cursorPageSchema(ticketSummarySchema, 'TicketPage');

export type TicketPage = z.infer<typeof ticketPageSchema>;

/** The admin queue's tabs (TK12): `open` is "بانتظار ردّك", oldest customer message first. */
export const ADMIN_TICKET_TABS = ['open', 'answered', 'closed', 'all'] as const;

export const adminTicketTabSchema = z.enum(ADMIN_TICKET_TABS);

export type AdminTicketTab = z.infer<typeof adminTicketTabSchema>;

/** `GET /api/admin/support/tickets` (TK12). */
export const adminTicketListQuerySchema = cursorQuerySchema
  .extend({
    status: adminTicketTabSchema.default('open'),
    category: ticketCategorySchema.optional(),
    customerId: z.uuid().optional(),
    /** A ticket number, as typed. */
    q: z.string().trim().min(1).max(20).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .meta({ id: 'AdminTicketListQuery' });

export type AdminTicketListQuery = z.infer<typeof adminTicketListQuerySchema>;

const adminTicketCustomer = {
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  status: customerStatusSchema,
};

/** One row of the admin queue (TK12). */
export const adminTicketSummarySchema = z
  .object({ ...ticketSummary, customer: z.object(adminTicketCustomer) })
  .meta({ id: 'AdminTicketSummary' });

export type AdminTicketSummary = z.infer<typeof adminTicketSummarySchema>;

/** The queue with the `open` count of the navigation badge (TK13). */
export const adminTicketPageSchema = z
  .object({
    items: z.array(adminTicketSummarySchema),
    nextCursor: z.string().nullable(),
    openCount: z.int().nonnegative(),
  })
  .meta({ id: 'AdminTicketPage' });

export type AdminTicketPage = z.infer<typeof adminTicketPageSchema>;

/** `GET /api/admin/support/tickets/:id`: the thread and its side panel. */
export const adminTicketSchema = z
  .object({
    ...ticketSummary,
    messages: z.array(ticketMessage),
    customer: z.object({
      ...adminTicketCustomer,
      phone: z.string(),
      isTest: z.boolean(),
      marks: customerMarksSchema,
    }),
    orderSummary: z
      .object({
        id: z.uuid(),
        number: z.string(),
        status: orderStatusSchema,
        productNameAr: z.string(),
        quantity: z.int().positive(),
        totalUsdUnits: amountUnitsSchema,
        createdAt: z.iso.datetime(),
      })
      .nullable(),
    depositSummary: z
      .object({
        id: z.uuid(),
        referenceCode: z.string(),
        method: depositMethodSchema,
        status: depositStatusSchema,
        declaredUsdUnits: amountUnitsSchema,
        createdAt: z.iso.datetime(),
      })
      .nullable(),
  })
  .meta({ id: 'AdminTicket' });

export type AdminTicket = z.infer<typeof adminTicketSchema>;

/* Channels (SC1, SC2) --------------------------------------------------------------------- */

/** `https://t.me/<name>` only: a stolen session cannot point customers elsewhere. */
export const telegramSupportUrlSchema = z
  .string()
  .trim()
  .regex(/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}$/);

/** `GET /api/support/channels` (public). */
export const supportChannelsSchema = z
  .object({ telegramUrl: z.string().nullable() })
  .meta({ id: 'SupportChannels' });

export type SupportChannels = z.infer<typeof supportChannelsSchema>;

/** `GET` and `PUT /api/admin/support/settings`; null hides the link (SC1). */
export const supportSettingsSchema = z
  .object({ telegramUrl: telegramSupportUrlSchema.nullable() })
  .meta({ id: 'SupportSettings' });

export type SupportSettings = z.infer<typeof supportSettingsSchema>;
