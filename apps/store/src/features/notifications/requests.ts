import type {
  NotificationEvent,
  NotificationPage,
  NotificationPreferences,
  UnreadCount,
} from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The customer's notification center (S05 rules NT5, NT8): the session cookie says whose. Never
 * cached.
 */

type Fetcher = typeof fetch;

/** One page, newest first; `cursor` from the previous page. */
export function listNotifications(cursor?: string, fetcher: Fetcher = fetch) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return apiRequest<NotificationPage>(`/api/notifications${query}`, { fetcher });
}

/** The unread count alone (the bell, after a `resync` or when the tab shows again). */
export async function getUnreadCount(fetcher: Fetcher = fetch) {
  const page = await apiRequest<NotificationPage>('/api/notifications?limit=1', { fetcher });
  return page.ok ? page.data.unreadCount : null;
}

/** Marks everything up to `upToId`, included, as read; answers the new count. */
export function markNotificationsRead(upToId: string, fetcher: Fetcher = fetch) {
  return apiRequest<UnreadCount>('/api/notifications/read', {
    method: 'POST',
    body: { upToId },
    fetcher,
  });
}

export function getNotificationPreferences(fetcher: Fetcher = fetch) {
  return apiRequest<NotificationPreferences>('/api/account/notification-preferences', { fetcher });
}

export function setNotificationPreference(
  event: NotificationEvent,
  email: boolean,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<NotificationPreferences>('/api/account/notification-preferences', {
    method: 'PUT',
    body: { event, email },
    fetcher,
  });
}
