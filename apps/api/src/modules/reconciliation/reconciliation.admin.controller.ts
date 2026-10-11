import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  SerializeOptions,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  explainResultSchema,
  type ReconciliationRunQuery,
  type ReconciliationSettings,
  reconciliationOverviewSchema,
  reconciliationResultSchema,
  reconciliationRunDetailSchema,
  reconciliationRunPageSchema,
  reconciliationRunQuerySchema,
  reconciliationRunSchema,
  reconciliationSettingsSchema,
  type ShamCashCount,
  shamCashCountSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * The reconciliation (S13): the overview, runs and results, a manual run (`202`, run by the
 * worker), Sham Cash counts (checked at once), explanations and the settings (re-authentication).
 */
@ApiTags('reconciliation')
@Controller('admin/reconciliation')
export class ReconciliationAdminController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: reconciliationOverviewSchema })
  @ApiOkResponse({
    description: 'The state of the books',
    standardSchema: reconciliationOverviewSchema,
  })
  overview() {
    return this.reconciliation.overview();
  }

  @Get('runs')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(reconciliationRunQuerySchema)
  @SerializeOptions({ schema: reconciliationRunPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: reconciliationRunPageSchema })
  runs(@Query({ schema: reconciliationRunQuerySchema }) query: ReconciliationRunQuery) {
    return this.reconciliation.runs(query);
  }

  @Get('runs/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: reconciliationRunDetailSchema })
  @ApiOkResponse({
    description: 'A run and its results',
    standardSchema: reconciliationRunDetailSchema,
  })
  run(@Param('id') id: string) {
    return this.reconciliation.run(id);
  }

  @Post('runs')
  @AdminRoute()
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: reconciliationRunSchema })
  @ApiAcceptedResponse({
    description: 'Queued for the worker',
    standardSchema: reconciliationRunSchema,
  })
  start(@CurrentAdmin() admin: AdminIdentity, @Req() request: Request) {
    return this.reconciliation.startManual(admin.id, requestMeta(request));
  }

  @Post('results/:id/explanation')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: reconciliationResultSchema })
  @ApiCreatedResponse({
    description: 'The result, explained',
    standardSchema: reconciliationResultSchema,
  })
  explain(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: explainResultSchema }) body: { note: string },
    @Req() request: Request,
  ) {
    return this.reconciliation.explain(admin.id, id, body.note, requestMeta(request));
  }

  @Post('sham-cash-counts')
  @AdminRoute()
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: reconciliationRunDetailSchema })
  @ApiCreatedResponse({
    description: 'The count run and its result (200: a replay)',
    standardSchema: reconciliationRunDetailSchema,
  })
  async count(
    @CurrentAdmin() admin: AdminIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: shamCashCountSchema }) body: ShamCashCount,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { run, created } = await this.reconciliation.count(
      admin.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return run;
  }

  @Get('settings')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: reconciliationSettingsSchema })
  @ApiOkResponse({
    description: 'The settings in force',
    standardSchema: reconciliationSettingsSchema,
  })
  settings() {
    return this.reconciliation.settings();
  }

  @Put('settings')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: reconciliationSettingsSchema })
  @ApiOkResponse({ description: 'The new settings', standardSchema: reconciliationSettingsSchema })
  updateSettings(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: reconciliationSettingsSchema }) body: ReconciliationSettings,
    @Req() request: Request,
  ) {
    return this.reconciliation.updateSettings(admin.id, body, requestMeta(request));
  }
}
