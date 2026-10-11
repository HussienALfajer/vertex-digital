import { Controller, Get, Header, Param, Query, Req, Res, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  breakdownReportSchema,
  customersReportSchema,
  depositsReportSchema,
  ledgerReportSchema,
  REPORT_EXPORTS_PER_MINUTE,
  type ReportQuery,
  refundsReportSchema,
  reportQuerySchema,
  salesReportSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { AdminIdentity } from '../admin/index.js';
import { reportFileName } from './report-workbook.js';
import { ReportsService } from './reports.service.js';

/** Reports R1–R6 (S13) and their Excel export (audited, 10 a minute). */
@ApiTags('reports')
@Controller('admin/reports')
export class ReportsAdminController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(reportQuerySchema)
  @SerializeOptions({ schema: salesReportSchema })
  @ApiOkResponse({ description: 'R1: sales and profit by day', standardSchema: salesReportSchema })
  sales(@Query({ schema: reportQuerySchema }) query: ReportQuery) {
    return this.reports.report('sales', query);
  }

  @Get('breakdown')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(reportQuerySchema)
  @SerializeOptions({ schema: breakdownReportSchema })
  @ApiOkResponse({
    description: 'R2: by game, product or supplier',
    standardSchema: breakdownReportSchema,
  })
  breakdown(@Query({ schema: reportQuerySchema }) query: ReportQuery) {
    return this.reports.report('breakdown', query);
  }

  @Get('deposits')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(reportQuerySchema)
  @SerializeOptions({ schema: depositsReportSchema })
  @ApiOkResponse({ description: 'R3: deposits by method', standardSchema: depositsReportSchema })
  deposits(@Query({ schema: reportQuerySchema }) query: ReportQuery) {
    return this.reports.report('deposits', query);
  }

  @Get('refunds')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(reportQuerySchema)
  @SerializeOptions({ schema: refundsReportSchema })
  @ApiOkResponse({ description: 'R4: refunds and failures', standardSchema: refundsReportSchema })
  refunds(@Query({ schema: reportQuerySchema }) query: ReportQuery) {
    return this.reports.report('refunds', query);
  }

  @Get('customers')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(reportQuerySchema)
  @SerializeOptions({ schema: customersReportSchema })
  @ApiOkResponse({ description: 'R5: the top customers', standardSchema: customersReportSchema })
  customers(@Query({ schema: reportQuerySchema }) query: ReportQuery) {
    return this.reports.report('customers', query);
  }

  @Get('ledger')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(reportQuerySchema)
  @SerializeOptions({ schema: ledgerReportSchema })
  @ApiOkResponse({ description: 'R6: the money movement', standardSchema: ledgerReportSchema })
  ledger(@Query({ schema: reportQuerySchema }) query: ReportQuery) {
    return this.reports.report('ledger', query);
  }

  @Get(':kind/export')
  @AdminRoute()
  @RateLimit({ limit: REPORT_EXPORTS_PER_MINUTE, perSeconds: 60 })
  @ApiQueryOf(reportQuerySchema)
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'The report as an .xlsx file' })
  async export(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('kind') kindParam: string,
    @Query({ schema: reportQuerySchema }) query: ReportQuery,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const kind = this.reports.kindOf(kindParam);
    await this.reports.export(admin.id, kind, query, requestMeta(request), () => {
      response.status(200);
      response.setHeader('cache-control', 'no-store');
      response.setHeader(
        'content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      response.setHeader(
        'content-disposition',
        `attachment; filename="${reportFileName(kind, query.from, query.to)}"`,
      );
      return response;
    });
  }
}
