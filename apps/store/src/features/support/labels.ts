import type { TicketCategory, TicketStatus } from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';

/** A ticket's status chip (TK12): waiting for the team, answered, closed. */
export const STATUS_TONES = {
  open: 'info',
  answered: 'success',
  closed: 'neutral',
} as const satisfies Record<TicketStatus, string>;

export const statusText = (status: TicketStatus) => t(`support.statuses.${status}`);

export const categoryText = (category: TicketCategory) => t(`support.categories.${category}`);

/** "فتح تذكرة جديدة" with the closed ticket's type and link (TK4). */
export function newTicketHref(ticket: {
  category: TicketCategory;
  order: { id: string } | null;
  deposit: { id: string } | null;
}): string {
  const params = new URLSearchParams({ category: ticket.category });
  if (ticket.category === 'order' && ticket.order) params.set('order', ticket.order.id);
  if (ticket.category === 'deposit' && ticket.deposit) params.set('deposit', ticket.deposit.id);
  return `/support/new?${params}`;
}
