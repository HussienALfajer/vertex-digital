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
    placeholderData: keepPreviousData,
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
      link.click();
      URL.revokeObjectURL(url);
    },
  });
}
