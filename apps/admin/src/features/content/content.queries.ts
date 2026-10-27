import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AnnouncementInput,
  AnnouncementTone,
  BannerImage,
  BannerInput,
  ContentPage,
  FaqOrder,
  SaveFaqItem,
  SaveFaqSection,
  SavePageDraft,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * Store content (S14): the four pages, the FAQ, banners, announcements and live activity. Keys
 * start with `content`. A change can move another tab's figures (an enable disables another
 * announcement, a publish clears a badge), so every mutation reads the module again. A read of what
 * is already shown (after a change, the tab seen again) is background work (rule D4, audit A08-23).
 */

type Key = readonly unknown[];
const again = (client: { getQueryData: (key: Key) => unknown }, queryKey: Key) =>
  client.getQueryData(queryKey) === undefined ? undefined : BACKGROUND_REQUEST;

export const pagesQuery = queryOptions({
  queryKey: ['content', 'pages'],
  queryFn: ({ client, queryKey }) =>
    call(api.GET('/api/admin/content/pages', { headers: again(client, queryKey) })),
});

export const pageQuery = (page: ContentPage) =>
  queryOptions({
    queryKey: ['content', 'page', page],
    queryFn: ({ client, queryKey }) =>
      call(
        api.GET('/api/admin/content/pages/{page}', {
          params: { path: { page } },
          headers: again(client, queryKey),
        }),
      ),
  });

export const pageVersionQuery = (page: ContentPage, version: number) =>
  queryOptions({
    queryKey: ['content', 'page', page, 'version', version],
    queryFn: () =>
      call(
        api.GET('/api/admin/content/pages/{page}/versions/{version}', {
          params: { path: { page, version } },
        }),
      ),
    // A version never changes once published.
    staleTime: Number.POSITIVE_INFINITY,
  });

export const faqQuery = (archived: boolean) =>
  queryOptions({
    queryKey: ['content', 'faq', { archived }],
    queryFn: ({ client, queryKey }) =>
      call(
        api.GET('/api/admin/content/faq', {
          params: { query: { archived: archived ? 'true' : undefined } },
          headers: again(client, queryKey),
        }),
      ),
  });

export const bannersQuery = (archived: boolean) =>
  queryOptions({
    queryKey: ['content', 'banners', { archived }],
    queryFn: ({ client, queryKey }) =>
      call(
        api.GET('/api/admin/content/banners', {
          params: { query: { archived: archived ? 'true' : undefined } },
          headers: again(client, queryKey),
        }),
      ),
  });

export const announcementsQuery = (archived: boolean) =>
  queryOptions({
    queryKey: ['content', 'announcements', { archived }],
    queryFn: ({ client, queryKey }) =>
      call(
        api.GET('/api/admin/content/announcements', {
          params: { query: { archived: archived ? 'true' : undefined } },
          headers: again(client, queryKey),
        }),
      ),
  });

export const settingsQuery = queryOptions({
  queryKey: ['content', 'settings'],
  queryFn: ({ client, queryKey }) =>
    call(api.GET('/api/admin/content/settings', { headers: again(client, queryKey) })),
});

export const activityQuery = queryOptions({
  queryKey: ['content', 'activity'],
  queryFn: ({ client, queryKey }) =>
    call(api.GET('/api/admin/content/activity', { headers: again(client, queryKey) })),
});

/** A content change through the re-authentication wrapper (rule D5), reading the module again. */
function useContentMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['content'] }),
  });
}

// Pages -----------------------------------------------------------------------------------------

/** Rule PG3: the draft as the editor holds it, with the revision it last read. */
export const useSaveDraft = (page: ContentPage) =>
  useContentMutation((body: SavePageDraft) =>
    call(api.PUT('/api/admin/content/pages/{page}/draft', { params: { path: { page } }, body })),
  );

/** Rule PG5: the revision that was previewed. */
export const usePublishPage = (page: ContentPage) =>
  useContentMutation((revision: number) =>
    call(
      api.POST('/api/admin/content/pages/{page}/publish', {
        params: { path: { page } },
        body: { revision },
      }),
    ),
  );

/** Rule PG6. */
export const useRestoreVersion = (page: ContentPage) =>
  useContentMutation(({ version, revision }: { version: number; revision: number }) =>
    call(
      api.POST('/api/admin/content/pages/{page}/versions/{version}/restore', {
        params: { path: { page, version } },
        body: { revision },
      }),
    ),
  );

// FAQ -------------------------------------------------------------------------------------------

export const useSaveSection = () =>
  useContentMutation(({ id, body }: { id?: string; body: SaveFaqSection }) =>
    call(
      id
        ? api.PATCH('/api/admin/content/faq/sections/{id}', { params: { path: { id } }, body })
        : api.POST('/api/admin/content/faq/sections', { body }),
    ),
  );

export const useArchiveSection = () =>
  useContentMutation(({ id, archive }: { id: string; archive: boolean }) =>
    call(
      archive
        ? api.POST('/api/admin/content/faq/sections/{id}/archive', { params: { path: { id } } })
        : api.POST('/api/admin/content/faq/sections/{id}/restore', { params: { path: { id } } }),
    ),
  );

export const useSaveItem = () =>
  useContentMutation(({ id, body }: { id?: string; body: SaveFaqItem }) =>
    call(
      id
        ? api.PATCH('/api/admin/content/faq/items/{id}', { params: { path: { id } }, body })
        : api.POST('/api/admin/content/faq/items', { body }),
    ),
  );

export const useArchiveItem = () =>
  useContentMutation(({ id, archive }: { id: string; archive: boolean }) =>
    call(
      archive
        ? api.POST('/api/admin/content/faq/items/{id}/archive', { params: { path: { id } } })
        : api.POST('/api/admin/content/faq/items/{id}/restore', { params: { path: { id } } }),
    ),
  );

/** Rule FQ4: every unarchived section and question, in the new order. */
export const useReorderFaq = () =>
  useContentMutation((body: FaqOrder) => call(api.PUT('/api/admin/content/faq/order', { body })));

/** Rule FQ6: the working revision that was previewed. */
export const usePublishFaq = () =>
  useContentMutation((revision: number) =>
    call(api.POST('/api/admin/content/faq/publish', { body: { revision } })),
  );

// Banners ---------------------------------------------------------------------------------------

/** Rule BN2: checked and re-encoded by the API; the banner form saves the returned id. */
export function useUploadBannerImage() {
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (file: File) =>
      withReauthentication(() => {
        const body = new FormData();
        body.append('file', file);
        // openapi-fetch sends a FormData body as it is, with its multipart boundary.
        return call<BannerImage>(
          api.POST('/api/admin/content/banners/image', { body: body as never }),
        );
      }),
  });
}

export const useSaveBanner = () =>
  useContentMutation(({ id, body }: { id?: string; body: BannerInput }) =>
    call(
      id
        ? api.PATCH('/api/admin/content/banners/{id}', { params: { path: { id } }, body })
        : api.POST('/api/admin/content/banners', { body }),
    ),
  );

const BANNER_ACTIONS = {
  enable: '/api/admin/content/banners/{id}/enable',
  disable: '/api/admin/content/banners/{id}/disable',
  archive: '/api/admin/content/banners/{id}/archive',
  restore: '/api/admin/content/banners/{id}/restore',
} as const;

export type RowAction = keyof typeof BANNER_ACTIONS;

export const useBannerAction = () =>
  useContentMutation(({ id, action }: { id: string; action: RowAction }) =>
    call(api.POST(BANNER_ACTIONS[action], { params: { path: { id } } })),
  );

/** Rule BN6. */
export const useReorderBanners = () =>
  useContentMutation((ids: string[]) =>
    call(api.PUT('/api/admin/content/banners/order', { body: { ids } })),
  );

// Announcements ---------------------------------------------------------------------------------

export const useSaveAnnouncement = () =>
  useContentMutation(
    ({ id, body }: { id?: string; body: AnnouncementInput & { tone: AnnouncementTone } }) =>
      call(
        id
          ? api.PATCH('/api/admin/content/announcements/{id}', { params: { path: { id } }, body })
          : api.POST('/api/admin/content/announcements', { body }),
      ),
  );

const ANNOUNCEMENT_ACTIONS = {
  enable: '/api/admin/content/announcements/{id}/enable',
  disable: '/api/admin/content/announcements/{id}/disable',
  archive: '/api/admin/content/announcements/{id}/archive',
  restore: '/api/admin/content/announcements/{id}/restore',
} as const;

export const useAnnouncementAction = () =>
  useContentMutation(({ id, action }: { id: string; action: RowAction }) =>
    call(api.POST(ANNOUNCEMENT_ACTIONS[action], { params: { path: { id } } })),
  );

// Live activity ---------------------------------------------------------------------------------

/** Rule LA6. */
export const useSetLiveActivity = () =>
  useContentMutation((liveActivityEnabled: boolean) =>
    call(api.PUT('/api/admin/content/settings', { body: { liveActivityEnabled } })),
  );
