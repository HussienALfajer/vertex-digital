import { infiniteQueryOptions } from '@tanstack/react-query';
import { api, call } from '../../lib/api/client';
import { type AuditSearch, toAuditQuery } from './audit-search';

/** The audit log, newest first, a page of 50 at a time (rule A4). Keys start with `audit`. */
export const auditListQuery = (search: AuditSearch) =>
  infiniteQueryOptions({
    queryKey: ['audit', 'list', search],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/audit', {
          params: { query: { ...toAuditQuery(search), cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
