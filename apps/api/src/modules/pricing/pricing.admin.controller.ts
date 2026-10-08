import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  marginRuleSchema,
  pricingPreviewRequestSchema,
  pricingPreviewSchema,
  type SetMarginRule,
  setMarginRuleSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { PricingService } from './pricing.service.js';

/** Margin rules and the price preview in the panel (S06, F10). Rule changes re-authenticate. */
@ApiTags('pricing')
@Controller('admin/pricing')
export class PricingAdminController {
  constructor(private readonly pricing: PricingService) {}

  @Get('rules')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: marginRuleSchema })
  @ApiOkResponse({ description: 'Live rules', standardSchema: marginRuleSchema.array() })
  rules() {
    return this.pricing.rules();
  }

  /** Rule PR9. */
  @Put('rules')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: marginRuleSchema })
  @ApiOkResponse({ description: 'The live rule of the target', standardSchema: marginRuleSchema })
  setRule(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: setMarginRuleSchema }) body: SetMarginRule,
    @Req() request: Request,
  ) {
    return this.pricing.setRule(admin.id, body, requestMeta(request));
  }

  @Post('rules/:id/archive')
  @AdminRoute()
  @Sensitive()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'Archived; the target falls back to its parent rule' })
  archiveRule(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.pricing.archiveRule(admin.id, id, requestMeta(request));
  }

  /** Rule PR10: writes nothing. */
  @Post('preview')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: pricingPreviewSchema })
  @ApiOkResponse({ description: 'The price for this cost', standardSchema: pricingPreviewSchema })
  preview(
    @Body({ schema: pricingPreviewRequestSchema })
    body: z.output<typeof pricingPreviewRequestSchema>,
  ) {
    return this.pricing.preview(body);
  }
}
