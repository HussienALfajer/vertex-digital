import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type ApproveRateSuggestion,
  approveRateSuggestionSchema,
  changeRateSettingsSchema,
  exchangeRateRecordSchema,
  type RateSettingsValues,
  type RateSuggestionListQuery,
  rateSettingsSchema,
  rateSuggestionListQuerySchema,
  rateSuggestionPageSchema,
  rateSuggestionSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { RateSettingsService } from './rate-settings.service.js';
import { RateSuggestionsService } from './rate-suggestions.service.js';

/** S27: rate suggestions (approve re-authenticated, reject) and the automatic updates' settings. */
@ApiTags('rates')
@Controller('admin')
export class RateSuggestionsAdminController {
  constructor(
    private readonly suggestions: RateSuggestionsService,
    private readonly settings: RateSettingsService,
  ) {}

  @Get('rate-suggestions')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(rateSuggestionListQuerySchema)
  @SerializeOptions({ schema: rateSuggestionPageSchema })
  @ApiOkResponse({
    description: 'Suggestions, newest first',
    standardSchema: rateSuggestionPageSchema,
  })
  list(@Query({ schema: rateSuggestionListQuerySchema }) query: RateSuggestionListQuery) {
    return this.suggestions.list(query);
  }

  /** SG3: the proposed value or an edit; FX2's typed confirmation above 5%. */
  @Post('rate-suggestions/:id/approve')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: exchangeRateRecordSchema })
  @ApiCreatedResponse({ description: 'The rate written', standardSchema: exchangeRateRecordSchema })
  approve(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: approveRateSuggestionSchema }) body: ApproveRateSuggestion,
    @Req() request: Request,
  ) {
    return this.suggestions.approve(admin.id, id, body, requestMeta(request));
  }

  @Post('rate-suggestions/:id/reject')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSuggestionSchema })
  @ApiOkResponse({ description: 'The rejected suggestion', standardSchema: rateSuggestionSchema })
  reject(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.suggestions.reject(admin.id, id, requestMeta(request));
  }

  @Get('rate-settings')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSettingsSchema })
  @ApiOkResponse({ description: 'The settings in force', standardSchema: rateSettingsSchema })
  getSettings() {
    return this.settings.get();
  }

  /** ST1: turning automatic updates on, or any threshold, needs a re-authentication. */
  @Post('rate-settings')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSettingsSchema })
  @ApiCreatedResponse({ description: 'The settings in force', standardSchema: rateSettingsSchema })
  changeSettings(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: changeRateSettingsSchema }) body: RateSettingsValues,
    @Req() request: Request,
  ) {
    return this.settings.change(admin.id, body, requestMeta(request));
  }
}
