'use client';

import { useNotificationEvents } from '@/features/notifications/live';

/**
 * Rule TK9 on the store: a reply (or a `resync` after the stream was down) reads the tickets
 * again. Mounted only for a signed-in customer: the stream needs the session.
 */
export function OnTicketReplied({ onReply, ticketId }: { onReply: () => void; ticketId?: string }) {
  useNotificationEvents((event) => {
    if (
      event.type === 'resync' ||
      (event.type === 'notification' &&
        event.notification.event === 'ticket_replied' &&
        (!ticketId || event.notification.params.ticketId === ticketId))
    )
      onReply();
  });
  return null;
}
