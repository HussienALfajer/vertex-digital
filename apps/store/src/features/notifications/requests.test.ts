import { describe, expect, it } from 'vitest';
import {
  getUnreadCount,
  listNotifications,
  markNotificationsRead,
  setNotificationPreference,
} from './requests';

/** A fetch that answers with one response and records what was asked. */
function fetcher(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('notification requests', () => {
  it('read the first page, then the next one with its cursor', async () => {
    const { fetch, calls } = fetcher(200, { items: [], nextCursor: null, unreadCount: 0 });
    await listNotifications(undefined, fetch);
    await listNotifications('a b/c', fetch);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/notifications',
      '/api/notifications?cursor=a+b%2Fc',
    ]);
  });

  it('read the unread count alone, null when it fails', async () => {
    expect(
      await getUnreadCount(fetcher(200, { items: [], nextCursor: null, unreadCount: 4 }).fetch),
    ).toBe(4);
    expect(await getUnreadCount(fetcher(401, { code: 'UNAUTHORIZED' }).fetch)).toBeNull();
  });

  it('mark read up to an id and save one email choice', async () => {
    const read = fetcher(200, { unreadCount: 0 });
    await markNotificationsRead('id-1', read.fetch);
    expect(read.calls[0]).toMatchObject({
      url: '/api/notifications/read',
      init: { method: 'POST', body: JSON.stringify({ upToId: 'id-1' }) },
    });
    const saved = fetcher(200, { email: {} });
    await setNotificationPreference('deposit_rejected', false, saved.fetch);
    expect(saved.calls[0]).toMatchObject({
      url: '/api/account/notification-preferences',
      init: { method: 'PUT', body: JSON.stringify({ event: 'deposit_rejected', email: false }) },
    });
  });
});
