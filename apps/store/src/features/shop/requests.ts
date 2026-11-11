import type {
  PlayerCheck,
  PlayerCheckRequest,
  ReturnRequest,
  RevealedCode,
  ShopCustomerProfile,
  ShopNotificationPage,
  ShopOrder,
  ShopOrderPage,
  ShopPurchase,
  ShopSignUp,
  ShopTicket,
  ShopTicketPage,
  ShopWallet,
  ShopWalletEntryPage,
} from '@vertex-digital/contracts';
import { apiRequest, type Result } from '@/lib/api';
import { withAltcha } from '../auth/requests';
import { shopApi } from './paths';

/*
 * A shop customer's calls (S26), all under `/api/shops/<slug>/`: the shop's own Better Auth
 * instance and session cookie (ADR 0040), never the store's `/api/auth`. The slug names the shop;
 * a session of another shop answers `401` as none. Never cached.
 */

type Fetcher = typeof fetch;

const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(name, String(value));
  }
  return params.size > 0 ? `?${params}` : '';
};

// --- Account (CA2, CA4) ---

/** CA4: after 3 failures for the email the API asks for proof of work, solved and sent once. */
export async function shopSignIn(
  slug: string,
  email: string,
  password: string,
  { fetcher = fetch, onVerifying }: { fetcher?: Fetcher; onVerifying?: () => void } = {},
): Promise<Result<unknown>> {
  const send = (headers?: Record<string, string>) =>
    apiRequest(shopApi(slug, '/auth/sign-in/email'), {
      method: 'POST',
      body: { email, password },
      headers,
      fetcher,
    });
  const result = await send();
  if (result.ok || (result.reason !== 'ALTCHA_REQUIRED' && result.reason !== 'ALTCHA_INVALID')) {
    return result;
  }
  onVerifying?.();
  return withAltcha(send, fetcher);
}

/** CA2: the same answer for a known email (CA3); the code follows by email. */
export function shopSignUp(slug: string, input: ShopSignUp, fetcher: Fetcher = fetch) {
  return withAltcha(
    (headers) =>
      apiRequest(shopApi(slug, '/auth/sign-up'), {
        method: 'POST',
        body: input,
        headers,
        fetcher,
      }),
    fetcher,
  );
}

export function shopSendVerificationCode(slug: string, email: string, fetcher: Fetcher = fetch) {
  return withAltcha(
    (headers) =>
      apiRequest(shopApi(slug, '/auth/send-verification-otp'), {
        method: 'POST',
        body: { email },
        headers,
        fetcher,
      }),
    fetcher,
  );
}

/** The code with the account's password verifies the email and opens the session. */
export function shopVerifyEmail(
  slug: string,
  input: { email: string; otp: string; password: string },
  fetcher: Fetcher = fetch,
) {
  return apiRequest(shopApi(slug, '/auth/email-otp/verify-email'), {
    method: 'POST',
    body: input,
    fetcher,
  });
}

export function shopRequestPasswordReset(slug: string, email: string, fetcher: Fetcher = fetch) {
  return withAltcha(
    (headers) =>
      apiRequest(shopApi(slug, '/auth/request-password-reset'), {
        method: 'POST',
        body: { email },
        headers,
        fetcher,
      }),
    fetcher,
  );
}

/** Sets the new password; every session of the account ends. */
export function shopResetPassword(
  slug: string,
  input: { email: string; otp: string; password: string },
  fetcher: Fetcher = fetch,
) {
  return apiRequest(shopApi(slug, '/auth/reset-password'), {
    method: 'POST',
    body: input,
    fetcher,
  });
}

/** CA1: the invitation's token and the new password verify the email and open the session. */
export function shopAcceptInvitation(
  slug: string,
  input: { token: string; password: string },
  fetcher: Fetcher = fetch,
) {
  return apiRequest(shopApi(slug, '/auth/invitation'), {
    method: 'POST',
    body: input,
    fetcher,
  });
}

export function shopSignOut(slug: string, fetcher: Fetcher = fetch) {
  return apiRequest(shopApi(slug, '/auth/sign-out'), { method: 'POST', body: {}, fetcher });
}

/** CA8: a code to the new address (the same answer when the shop holds it, CA3). */
export function shopRequestEmailChange(
  slug: string,
  input: { newEmail: string; password: string },
  fetcher: Fetcher = fetch,
) {
  return withAltcha(
    (headers) =>
      apiRequest(shopApi(slug, '/account/request-email-change'), {
        method: 'POST',
        body: input,
        headers,
        fetcher,
      }),
    fetcher,
  );
}

/** CA8: the code from the new address changes the email; other sessions are signed out. */
export function shopConfirmEmailChange(
  slug: string,
  input: { newEmail: string; otp: string },
  fetcher: Fetcher = fetch,
) {
  return apiRequest(shopApi(slug, '/account/change-email'), {
    method: 'POST',
    body: input,
    fetcher,
  });
}

export function getShopProfile(slug: string, fetcher: Fetcher = fetch) {
  return apiRequest<ShopCustomerProfile>(shopApi(slug, '/me'), { fetcher });
}

// --- Wallet and returns (WL5, WL6) ---

export function getShopWallet(slug: string, fetcher: Fetcher = fetch) {
  return apiRequest<ShopWallet>(shopApi(slug, '/wallet'), { fetcher });
}

export function listShopWalletEntries(
  slug: string,
  { cursor }: { cursor?: string } = {},
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopWalletEntryPage>(shopApi(slug, `/wallet/entries${query({ cursor })}`), {
    fetcher,
  });
}

/** WL5: "تأكيد" moves the amount back to the merchant; `key` keeps a retry from moving it twice. */
export function answerReturnRequest(
  slug: string,
  id: string,
  answer: 'confirm' | 'decline',
  key: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ReturnRequest>(
    shopApi(slug, `/return-requests/${encodeURIComponent(id)}/${answer}`),
    { method: 'POST', headers: { 'idempotency-key': key }, fetcher },
  );
}

// --- Purchase and orders (PR5–PR12) ---

export function checkShopPlayer(slug: string, body: PlayerCheckRequest, fetcher: Fetcher = fetch) {
  return apiRequest<PlayerCheck>(shopApi(slug, '/player-checks'), {
    method: 'POST',
    body,
    fetcher,
  });
}

/** PR5: pays from the shop wallet at the selling price the page showed. */
export function createShopOrder(
  slug: string,
  body: ShopPurchase,
  key: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopOrder>(shopApi(slug, '/orders'), {
    method: 'POST',
    body,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

export function listShopOrders(
  slug: string,
  { cursor, limit }: { cursor?: string; limit?: number } = {},
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopOrderPage>(shopApi(slug, `/orders${query({ cursor, limit })}`), {
    fetcher,
  });
}

export function getShopOrder(slug: string, number: string, fetcher: Fetcher = fetch) {
  return apiRequest<ShopOrder>(shopApi(slug, `/orders/${encodeURIComponent(number)}`), {
    fetcher,
  });
}

/** PR12: a code's value, logged as revealed (S08). */
export function revealShopCode(
  slug: string,
  number: string,
  codeId: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<RevealedCode>(
    shopApi(
      slug,
      `/orders/${encodeURIComponent(number)}/codes/${encodeURIComponent(codeId)}/reveal`,
    ),
    { method: 'POST', fetcher },
  );
}

// --- Notifications and push (PR9, SP1) ---

export function listShopNotifications(
  slug: string,
  { cursor }: { cursor?: string } = {},
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopNotificationPage>(shopApi(slug, `/notifications${query({ cursor })}`), {
    fetcher,
  });
}

/** Everything up to this notification, included, is read (S05 NT5). */
export function markShopNotificationsRead(slug: string, upToId: string, fetcher: Fetcher = fetch) {
  return apiRequest<{ unreadCount: number }>(shopApi(slug, '/notifications/read'), {
    method: 'POST',
    body: { upToId },
    fetcher,
  });
}

export function shopUnreadCount(slug: string, fetcher: Fetcher = fetch) {
  return apiRequest<{ unreadCount: number }>(shopApi(slug, '/notifications/unread-count'), {
    fetcher,
  });
}

export function saveShopPushSubscription(
  slug: string,
  subscription: PushSubscriptionJSON,
  fetcher: Fetcher = fetch,
) {
  return apiRequest(shopApi(slug, '/push-subscription'), {
    method: 'PUT',
    body: subscription,
    fetcher,
  });
}

export function deleteShopPushSubscription(
  slug: string,
  endpoint: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest(shopApi(slug, '/push-subscription'), {
    method: 'DELETE',
    body: { endpoint },
    fetcher,
  });
}

// --- Tickets (TK1–TK3) ---

export function listShopTickets(
  slug: string,
  { cursor }: { cursor?: string } = {},
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopTicketPage>(shopApi(slug, `/tickets${query({ cursor })}`), { fetcher });
}

export function getShopTicket(slug: string, id: string, fetcher: Fetcher = fetch) {
  return apiRequest<ShopTicket>(shopApi(slug, `/tickets/${encodeURIComponent(id)}`), {
    fetcher,
  });
}

export type NewShopTicket = {
  orderId?: string | null;
  subject: string;
  body: string;
};

function multipart(fields: Record<string, string | null | undefined>): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) if (value) body.append(name, value);
  return body;
}

/** TK1: to the merchant first; an order's ticket names it. ALTCHA as every new ticket (S12). */
export function openShopTicket(
  slug: string,
  ticket: NewShopTicket,
  key: string,
  fetcher: Fetcher = fetch,
): Promise<Result<ShopTicket>> {
  return withAltcha(
    (headers) =>
      apiRequest<ShopTicket>(shopApi(slug, '/tickets'), {
        method: 'POST',
        body: multipart({
          category: ticket.orderId ? 'order' : 'other',
          orderId: ticket.orderId,
          subject: ticket.subject,
          body: ticket.body,
        }),
        headers: { ...headers, 'idempotency-key': key },
        fetcher,
      }),
    fetcher,
  );
}

export function replyToShopTicket(
  slug: string,
  id: string,
  body: string,
  key: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopTicket>(shopApi(slug, `/tickets/${encodeURIComponent(id)}/messages`), {
    method: 'POST',
    body: multipart({ body }),
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

/** TK2: "طلب تدخل الإدارة", once the merchant left the customer 24 hours without a reply. */
export function escalateShopTicket(slug: string, id: string, fetcher: Fetcher = fetch) {
  return apiRequest<ShopTicket>(shopApi(slug, `/tickets/${encodeURIComponent(id)}/escalate`), {
    method: 'POST',
    fetcher,
  });
}

/** SP3: one page view; the API leaves bots out. Fire and forget. */
export function countShopVisit(slug: string, fetcher: Fetcher = fetch) {
  return apiRequest(shopApi(slug, '/visits'), { method: 'POST', fetcher });
}
