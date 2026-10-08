import { Body, Controller, Get, Header, Post, Query, Req, SerializeOptions } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type ChangeRate,
  type CursorQuery,
  changeRateSchema,
  cursorQuerySchema,
  exchangeRateRecordSchema,
  ratesOverviewSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { RatesService } from './rates.service.js';

/** The admin's exchange rate (S03, F04): history, and a change with re-authentication (FX1). */
@ApiTags('rates')
@Controller('admin')
export class RatesAdminController {
  constructor(private readonly rates: RatesService) {}

  @Get('rates')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(cursorQuerySchema)
  @SerializeOptions({ schema: ratesOverviewSchema })
  @ApiOkResponse({
    description: 'The current rate and the history, newest first',
    standardSchema: ratesOverviewSchema,
  })
  overview(@Query({ schema: cursorQuerySchema }) query: CursorQuery) {
    return this.rates.overview(query);
  }

  @Post('rates')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: exchangeRateRecordSchema })
  @ApiCreatedResponse({ description: 'The new rate', standardSchema: exchangeRateRecordSchema })
  change(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: changeRateSchema }) body: ChangeRate,
    @Req() request: Request,
  ) {
    return this.rates.change(admin.id, body, requestMeta(request));
  }
}
