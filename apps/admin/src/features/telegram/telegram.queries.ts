import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * The Telegram admin bot's page (S05, F07): the link status, linking, unlinking and a test
 * message (rules TG1, TG3). Keys start with `telegram`.
 */

/** How often the page reads the status while the link waits to be opened on the phone. */
const LINK_POLL_MS = 3000;

/** How often the page reads the status while the last message waits to be sent (audit A07-43). */
export const MESSAGE_POLL_MS = 3000;

/** Once shown, read again in the background (the test message's status, rule D4). */
export const telegramStatusQuery = queryOptions({
  queryKey: ['telegram', 'status'],
  queryFn: ({ client, queryKey }) =>
    call(
      api.GET('/api/admin/telegram', {
        headers: client.getQueryData(queryKey) ? BACKGROUND_REQUEST : undefined,
      }),
    ),
});

/** While a link is shown: the status in the background, until the chat is linked. */
export const telegramLinkPollQuery = queryOptions({
  queryKey: ['telegram', 'status', 'poll'],
  queryFn: () => call(api.GET('/api/admin/telegram', { headers: BACKGROUND_REQUEST })),
  refetchInterval: LINK_POLL_MS,
});

/** "ربط تيليجرام": a single-use link after re-authentication. */
export function useCreateLinkCode() {
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: () => withReauthentication(() => call(api.POST('/api/admin/telegram/link-code'))),
  });
}

export function useUnlinkTelegram() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: () => withReauthentication(() => call(api.DELETE('/api/admin/telegram/link'))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram'] }),
  });
}

export function useSendTelegramTest() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: () => withReauthentication(() => call(api.POST('/api/admin/telegram/test'))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram'] }),
  });
}
