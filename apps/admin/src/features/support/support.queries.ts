import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AdminTicket,
  SupportSettings,
  TicketCategory,
  TicketMessageInput,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import { type SupportSearch, tabOf } from './support-search';

/*
 * Support tickets as the admin works them (S12 F23): the queue and its badge (TK12, TK13), one
 * ticket with its side panel, replies and admin-opened tickets with up to 3 images (TK2, TK7),
 * closing, and the support settings (SC1). Keys start with `support`.
 */

/** The navigation badge reads the `open` count every minute in the background (TK13). */
const COUNT_REFRESH_MS = 60_000;

export const supportOpenCountQuery = queryOptions({
  queryKey: ['support', 'open-count'],
  queryFn: () =>
    call(
      api.GET('/api/admin/support/tickets', {
        params: { query: { status: 'open', limit: 1 } as never },
        headers: BACKGROUND_REQUEST,
      }),
    ),
  select: (page) => page.openCount,
  refetchInterval: COUNT_REFRESH_MS,
});

/** The queue (TK12): `open` oldest customer message first, the other tabs newest activity first. */
export const ticketListQuery = (search: SupportSearch) =>
  infiniteQueryOptions({
    queryKey: ['support', 'list', search],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/support/tickets', {
          params: {
            query: {
              status: tabOf(search),
              category: search.category,
              customerId: search.customerId,
              q: search.q,
              cursor: pageParam,
            } as never,
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

export const ticketQuery = (id: string) =>
  queryOptions({
    queryKey: ['support', 'ticket', id],
    queryFn: () => call(api.GET('/api/admin/support/tickets/{id}', { params: { path: { id } } })),
  });

/** The ticket's history in the side panel: its audit entries, newest first. */
export const ticketHistoryQuery = (id: string) =>
  queryOptions({
    queryKey: ['support', 'history', id],
    queryFn: () =>
      call(
        api.GET('/api/admin/audit', {
          params: { query: { entityType: 'support_ticket', entityId: id } as never },
        }),
      ),
  });

/** The link picker of an admin-opened ticket (TK2): the customer's last 30 orders. */
export const linkOrdersQuery = (customerId: string) =>
  queryOptions({
    queryKey: ['support', 'link-orders', customerId],
    queryFn: () =>
      call(
        api.GET('/api/admin/orders', {
          params: { query: { customerId, page: 1, pageSize: 30 } as never },
        }),
      ),
  });

/** The link picker of an admin-opened ticket (TK2): the customer's last 30 deposits. */
export const linkDepositsQuery = (customerId: string) =>
  queryOptions({
    queryKey: ['support', 'link-deposits', customerId],
    queryFn: () =>
      call(
        api.GET('/api/admin/deposits', {
          params: { query: { customerId, status: 'all', limit: 30 } as never },
        }),
      ),
  });

/** An image of a ticket (TK11): served to the admin only, never cached. */
export const attachmentUrl = (ticketId: string, fileId: string) =>
  `/api/admin/support/tickets/${ticketId}/attachments/${fileId}`;

export const supportSettingsQuery = queryOptions({
  queryKey: ['support', 'settings'],
  queryFn: () => call(api.GET('/api/admin/support/settings')),
});

/** A ticket change shows in the queue and its badge, the customer's profile and the audit log. */
function useSupportMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () =>
      Promise.all(
        ['support', 'customers', 'audit'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  });
}

/** The multipart body of a ticket or a message: its fields, then the images as `files`. */
function multipart(fields: Record<string, string | undefined>, files: File[]): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) body.append(name, value);
  }
  for (const file of files) body.append('files', file);
  return body;
}

/** TK5, TK7: a reply (it reopens a closed ticket), with the attempt's `Idempotency-Key`. */
export const useReplyTicket = (id: string) =>
  useSupportMutation(
    ({ body, files, key }: { body: TicketMessageInput; files: File[]; key: string }) =>
      // openapi-fetch sends a FormData body as it is, with its multipart boundary.
      call<AdminTicket>(
        api.POST('/api/admin/support/tickets/{id}/messages', {
          params: { path: { id }, header: { 'Idempotency-Key': key } },
          body: multipart({ body: body.body }, files) as never,
        }),
      ),
  );

/** The fields of an admin-opened ticket, as `adminCreateTicketSchema` checked them (TK2). */
export interface OpenTicketInput {
  customerId: string;
  category: TicketCategory;
  orderId?: string;
  depositId?: string;
  subject: string;
  body: string;
}

/** TK2: a ticket opened to a customer, starting `answered`. */
export const useOpenTicket = () =>
  useSupportMutation(
    ({ body, files, key }: { body: OpenTicketInput; files: File[]; key: string }) =>
      call<AdminTicket>(
        api.POST('/api/admin/support/tickets', {
          params: { header: { 'Idempotency-Key': key } },
          body: multipart(
            {
              customerId: body.customerId,
              category: body.category,
              orderId: body.orderId,
              depositId: body.depositId,
              subject: body.subject,
              body: body.body,
            },
            files,
          ) as never,
        }),
      ),
  );

/** TK3: closing a closed ticket returns it unchanged. */
export const useCloseTicket = (id: string) =>
  useSupportMutation(() =>
    call(api.POST('/api/admin/support/tickets/{id}/close', { params: { path: { id } } })),
  );

/** SC1: re-authentication; null hides the link. */
export const useSaveSupportSettings = () =>
  useSupportMutation((body: SupportSettings) =>
    call(api.PUT('/api/admin/support/settings', { body })),
  );
