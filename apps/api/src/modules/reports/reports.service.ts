import type { Writable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  type Report,
  type ReportKind,
  type ReportQuery,
  reportKindSchema,
  reportPeriodError,
} from '@vertex-digital/contracts';
import {
  breakdownReport,
  customersReport,
  type Database,
  depositsReport,
  ledgerReport,
  newId,
  recordAudit,
  refundsReport,
  salesReport,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { reportRowCount, writeReportWorkbook } from './report-workbook.js';

/**
 * Reports (S13 rules RP1–RP9, X1–X4): a read module with no tables of its own; the queries live
 * in `packages/db/src/reports`. An export is audited before its file is streamed.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The kind of a path segment: anything else is `VALIDATION_FAILED`. */
  kindOf(value: string): ReportKind {
    const parsed = reportKindSchema.safeParse(value);
    if (!parsed.success) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Unknown report', [
        { path: ['kind'], message: 'Expected a report kind' },
      ]);
    }
    return parsed.data;
  }

  async report<Kind extends ReportKind>(kind: Kind, query: ReportQuery): Promise<Report<Kind>> {
    if (reportPeriodError(query.from, query.to)) {
      throw new CodedException(400, 'REPORT_PERIOD_INVALID', 'The period is reversed or too long');
    }
    const period = { from: query.from, to: query.to };
    const generatedAt = new Date().toISOString();
    const body = await (async () => {
      switch (kind) {
        case 'sales':
          return salesReport(this.db, period);
        case 'breakdown':
          return breakdownReport(this.db, period, query.by ?? 'game');
        case 'deposits':
          return depositsReport(this.db, period);
        case 'refunds':
          return refundsReport(this.db, period);
        case 'customers':
          return customersReport(this.db, period);
        default:
          return ledgerReport(this.db, period);
      }
    })();
    return { ...body, generatedAt } as Report<Kind>;
  }

  /** Rule X4: the export's audit entry, then the workbook streamed to `stream`. */
  async export(
    adminId: string,
    kind: ReportKind,
    query: ReportQuery,
    meta: RequestMeta,
    stream: () => Writable,
  ): Promise<void> {
    const report = await this.report(kind, query);
    await this.db.transaction((tx) =>
      recordAudit(tx, {
        action: 'report.exported',
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        entityType: 'report',
        // One id per export: an export has no row of its own.
        entityId: newId(),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          kind,
          breakdown: kind === 'breakdown' ? (query.by ?? 'game') : null,
          from: query.from,
          to: query.to,
          rows: reportRowCount(kind, report),
        },
      }),
    );
    await writeReportWorkbook(stream(), kind, report);
  }
}
