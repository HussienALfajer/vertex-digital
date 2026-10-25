import type {
  DepositPage,
  OrderPage,
  OrderProblem,
  Ticket,
  TicketCategory,
  TicketPage,
  TicketSummary,
} from '@vertex-digital/contracts';
import { apiRequest, type Result } from '@/lib/api';
import { withAltcha } from '../auth/requests';

/*
 * The customer's support tickets (S12 TK1, TK7, TK11, TK12). The routes take no customer id: the
 * session cookie says whose tickets they are, and another customer's ticket answers `NOT_FOUND`.
 * Never cached.
 */

type Fetcher = typeof fetch;

/** One page of the customer's tickets, newest activity first; `cursor` from the previous page. */
export function listTickets(
  { cursor, limit }: { cursor?: string; limit?: number } = {},
  fetcher: Fetcher = fetch,
) {
  const params = new URLSearchParams({
    ...(cursor && { cursor }),
    ...(limit && { limit: String(limit) }),
  });
  const query = params.size > 0 ? `?${params}` : '';
  return apiRequest<TicketPage>(`/api/support/tickets${query}`, { fetcher });
}

export function getTicket(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<Ticket>(`/api/support/tickets/${encodeURIComponent(id)}`, { fetcher });
}

/** Where a ticket's image is served, to the ticket's customer only (TK11). */
export function attachmentUrl(ticketId: string, fileId: string): string {
  return `/api/support/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(fileId)}`;
}

export type NewTicket = {
  category: TicketCategory;
  orderId?: string | null;
  depositId?: string | null;
  subject: string;
  body: string;
  /** S22 OP5: the problem an order's problem button names. */
  orderProblem?: OrderProblem;
};

/** The multipart body: the fields, then each image as `files` in its order. */
function multipart(fields: Record<string, string | null | undefined>, files: Blob[]): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) if (value) body.append(name, value);
  for (const file of files) body.append('files', file);
  return body;
}

/**
 * Rule TK1: opens a ticket with up to 3 images. `key` is the attempt's `Idempotency-Key`: the
 * same key with the same body returns the first ticket. The API asks for a solved ALTCHA
 * challenge, as for a receipt.
 */
export function openTicket(
  ticket: NewTicket,
  files: Blob[],
  key: string,
  fetcher: Fetcher = fetch,
): Promise<Result<Ticket>> {
  return withAltcha(
    (headers) =>
      apiRequest<Ticket>('/api/support/tickets', {
        method: 'POST',
        body: multipart(
          {
            category: ticket.category,
            orderId: ticket.category === 'order' ? ticket.orderId : null,
            depositId: ticket.category === 'deposit' ? ticket.depositId : null,
            subject: ticket.subject,
            body: ticket.body,
            orderProblem: ticket.category === 'order' ? ticket.orderProblem : null,
          },
          files,
        ),
        headers: { ...headers, 'idempotency-key': key },
        fetcher,
      }),
    fetcher,
  );
}

/** Rule TK7: a message with up to 3 images; on a closed ticket it reopens it (TK4). */
export function replyToTicket(
  id: string,
  body: string,
  files: Blob[],
  key: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<Ticket>(`/api/support/tickets/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: multipart({ body }, files),
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

/** Rule TK3: closing a closed ticket returns it unchanged. */
export function closeTicket(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<Ticket>(`/api/support/tickets/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    fetcher,
  });
}

/** The most tickets one page holds: the help buttons look for an open one among them. */
const LOOKUP_LIMIT = 50;

/**
 * "تحتاج مساعدة؟" (S12 screens): the customer's ticket about this order or deposit that is not
 * closed, among their 50 most recently active tickets (there is at most one per order or deposit,
 * and a customer has few open ones), or null.
 */
export async function findOpenTicket(
  link: { orderId: string } | { depositId: string },
  fetcher: Fetcher = fetch,
): Promise<Result<TicketSummary | null>> {
  const page = await listTickets({ limit: LOOKUP_LIMIT }, fetcher);
  if (!page.ok) return page;
  const found = page.data.items.find(
    (ticket) =>
      ticket.status !== 'closed' &&
      ('orderId' in link
        ? ticket.order?.id === link.orderId
        : ticket.deposit?.id === link.depositId),
  );
  return { ok: true, data: found ?? null };
}

/** How many recent orders and deposits the new ticket's picker lists. */
export const PICKER_SIZE = 30;

export function recentOrders(fetcher: Fetcher = fetch) {
  return apiRequest<OrderPage>(`/api/orders?limit=${PICKER_SIZE}`, { fetcher });
}

export function recentDeposits(fetcher: Fetcher = fetch) {
  return apiRequest<DepositPage>(`/api/deposits?limit=${PICKER_SIZE}`, { fetcher });
}
