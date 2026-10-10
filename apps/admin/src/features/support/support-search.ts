import {
  ADMIN_TICKET_TABS,
  type AdminTicketTab,
  TICKET_CATEGORIES,
  type TicketCategory,
} from '@vertex-digital/contracts';

/*
 * The support queue's tab, filters and search as the URL holds them (S12 TK12), so a view can be
 * reloaded and shared. Anything invalid is dropped.
 */

export interface SupportSearch {
  /** Absent for "بانتظار ردّك" (`open`), so a plain link to `/support` opens the queue. */
  status?: Exclude<AdminTicketTab, 'open'>;
  category?: TicketCategory;
  customerId?: string;
  /** A ticket number, as typed. */
  q?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

export function parseSupportSearch(search: Record<string, unknown>): SupportSearch {
  const parsed: SupportSearch = {};
  if (
    (ADMIN_TICKET_TABS as readonly unknown[]).includes(search.status) &&
    search.status !== 'open'
  ) {
    parsed.status = search.status as SupportSearch['status'];
  }
  if ((TICKET_CATEGORIES as readonly unknown[]).includes(search.category)) {
    parsed.category = search.category as TicketCategory;
  }
  if (isUuid(search.customerId)) parsed.customerId = search.customerId;
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  if (q.length >= 1 && q.length <= 20) parsed.q = q;
  return parsed;
}

/** The tab a search shows. */
export const tabOf = (search: SupportSearch): AdminTicketTab => search.status ?? 'open';

/** A change of tab or filter; `undefined`, "الكل" or the queue tab clears it. */
export function withFilter(
  search: SupportSearch,
  change: Partial<Omit<SupportSearch, 'status'>> & { status?: AdminTicketTab },
): SupportSearch {
  const next: Record<string, unknown> = { ...search, ...change };
  if (next.status === 'open') delete next.status;
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return next as SupportSearch;
}

/** `/support/new?customer=`: the customer an admin-opened ticket is for (TK2). */
export function parseNewTicketSearch(search: Record<string, unknown>): { customer?: string } {
  return isUuid(search.customer) ? { customer: search.customer } : {};
}
