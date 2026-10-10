import { queryOptions } from '@tanstack/react-query';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';

/*
 * The panel's home page (S11, F18): one read of the api `dashboard` module. Keys start with
 * `dashboard`.
 */

/** Rule DB9: read again every minute; every read is background work, never the admin's activity. */
export const DASHBOARD_REFRESH_MS = 60_000;

export const dashboardQuery = queryOptions({
  queryKey: ['dashboard'],
  queryFn: () => call(api.GET('/api/admin/dashboard', { headers: BACKGROUND_REQUEST })),
  refetchInterval: DASHBOARD_REFRESH_MS,
});
