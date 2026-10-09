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
  Query,
  Req,
  SerializeOptions,
  UseInterceptors,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type DecideReviews,
  decideReviewsResultSchema,
  decideReviewsSchema,
  type MarginRuleValues,
  marginRuleSchema,
  marginRuleValuesSchema,
  type PriceReviewListQuery,
  priceReviewListQuerySchema,
  priceReviewPageSchema,
  priceReviewSchema,
  pricingPreviewRequestSchema,
  pricingPreviewSchema,
  type SetMarginRule,
  setMarginRuleSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import type { AdminIdentity } from '../admin/index.js';
import { PricingService } from './pricing.service.js';

/**
 * Margin rules and the price preview (S06, F10), and the price reviews (S07 rule P4). Rule
 * changes and margin adjustments re-authenticate.
 */
@ApiTags('pricing')
@UseInterceptors(StoreRevalidateInterceptor)
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

  @Get('reviews')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(priceReviewListQuerySchema)
  @SerializeOptions({ schema: priceReviewPageSchema })
  @ApiOkResponse({ description: 'A page of reviews', standardSchema: priceReviewPageSchema })
  reviews(@Query({ schema: priceReviewListQuerySchema }) query: PriceReviewListQuery) {
    return this.pricing.reviews(query);
  }

  /** Rule P4: each review decided on its own; the result per review. */
  @Post('reviews/decide')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: decideReviewsResultSchema })
  @ApiOkResponse({
    description: 'The result per review',
    standardSchema: decideReviewsResultSchema,
  })
  decide(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: decideReviewsSchema }) body: DecideReviews,
    @Req() request: Request,
  ) {
    return this.pricing.decide({ adminId: admin.id, meta: requestMeta(request) }, body);
  }

  /** Rule P4: a product margin rule and the review accepted at its price. */
  @Post('reviews/:id/adjust-margin')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: priceReviewSchema })
  @ApiOkResponse({ description: 'The decided review', standardSchema: priceReviewSchema })
  adjustMargin(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: marginRuleValuesSchema }) body: MarginRuleValues,
    @Req() request: Request,
  ) {
    return this.pricing.adjustMargin({ adminId: admin.id, meta: requestMeta(request) }, id, body);
  }
}
