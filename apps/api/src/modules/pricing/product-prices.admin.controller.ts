import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  SerializeOptions,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type PageQuery, pageQuerySchema, productPricePageSchema } from '@vertex-digital/contracts';
import { AdminRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { PricingService } from './pricing.service.js';

/** A product's stored prices (S07 rule P2), for the routes drawer. */
@ApiTags('pricing')
@Controller('admin/catalog/products')
export class ProductPricesAdminController {
  constructor(private readonly pricing: PricingService) {}

  @Get(':id/prices')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(pageQuerySchema)
  @SerializeOptions({ schema: productPricePageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: productPricePageSchema })
  prices(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query({ schema: pageQuerySchema }) query: PageQuery,
  ) {
    return this.pricing.prices(id, query);
  }
}
