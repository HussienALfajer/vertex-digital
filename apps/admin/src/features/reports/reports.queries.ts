import { keepPreviousData, queryOptions, useMutation } from '@tanstack/react-query';
import type { Report, ReportBreakdown, ReportKind } from '@vertex-digital/contracts';
import { ApiError, api, call } from '../../lib/api/client';

/*
 * Reports (S13, F22): one read per report and period, and the Excel export (rule X1–X4). Keys
 * start with `reports`.
 */

export interface ReportRequest {
  kind: ReportKind;
  from: string;
  to: string;
  by: ReportBreakdown;
}

function read<Kind extends ReportKind>(
  kind: Kind,
  query: { from: string; to: string },
  by: ReportBreakdown,
): Promise<Report<Kind>> {
  const params = { query };
  switch (kind) {
    case 'sales':
      return call(api.GET('/api/admin/reports/sales', { params })) as Promise<Report<Kind>>;
    case 'breakdown':
      return call(
        api.GET('/api/admin/reports/breakdown', { params: { query: { ...query, by } } }),
      ) as Promise<Report<Kind>>;
    case 'deposits':
      return call(api.GET('/api/admin/reports/deposits', { params })) as Promise<Report<Kind>>;
    case 'refunds':
      return call(api.GET('/api/admin/reports/refunds', { params })) as Promise<Report<Kind>>;
    case 'customers':
      return call(api.GET('/api/admin/reports/customers', { params })) as Promise<Report<Kind>>;
    default:
      return call(api.GET('/api/admin/reports/ledger', { params })) as Promise<Report<Kind>>;
  }
}

export const reportQuery = <Kind extends ReportKind>(request: ReportRequest & { kind: Kind }) =>
  queryOptions({
    queryKey: ['reports', request.kind, request.from, request.to, request.by],
    queryFn: () => read(request.kind, request, request.by),
    // The previous period's numbers stay up while a new period loads; never another report's,
    // whose shape its view cannot read.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === request.kind ? keepPreviousData(previous) : undefined,
  });

/** Rules X1–X4: the `.xlsx` the API streams, saved under its Latin file name. */
export function useExportReport() {
  return useMutation({
    mutationFn: async ({ kind, from, to, by }: ReportRequest) => {
      const query = kind === 'breakdown' ? { from, to, by } : { from, to };
      const { data, error, response } = await api.GET('/api/admin/reports/{kind}/export', {
        params: { path: { kind }, query },
        parseAs: 'blob',
      });
      if (!response.ok || !data) {
        const body = (error ?? {}) as { code?: string; details?: unknown; message?: string };
        throw new ApiError(
          response.status,
          body.code,
          body.details,
          body.message ?? `HTTP ${response.status}`,
        );
      }
      const url = URL.createObjectURL(data as Blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vertex-${kind}-${from}-${to}.xlsx`;
      // Attached while it is clicked, and the file's address kept a minute: some browsers read
      // it after the click returns, and a revoked one saves nothing (audit A09-34).
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });
}

/** S23 AD4: the report by tier of a `YYYY-MM` month. */
export const merchantTierReportQuery = (month: string) =>
  queryOptions({
    queryKey: ['reports', 'merchant-tiers', month],
    queryFn: () =>
      call(api.GET('/api/admin/reports/merchant-tiers', { params: { query: { month } } })),
    placeholderData: keepPreviousData,
  });

/** S23 AD4: the report by tier's `.xlsx`, as `useExportReport`. */
export function useExportMerchantTierReport() {
  return useMutation({
    mutationFn: async (month: string) => {
      const { data, error, response } = await api.GET('/api/admin/reports/merchant-tiers/export', {
        params: { query: { month } },
        parseAs: 'blob',
      });
      if (!response.ok || !data) {
        const body = (error ?? {}) as { code?: string; details?: unknown; message?: string };
        throw new ApiError(
          response.status,
          body.code,
          body.details,
          body.message ?? `HTTP ${response.status}`,
        );
      }
      const url = URL.createObjectURL(data as Blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vertex-merchant-tiers-${month}.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });
}
