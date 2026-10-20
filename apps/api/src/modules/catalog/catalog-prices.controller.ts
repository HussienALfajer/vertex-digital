import { Controller, Get, Header, Param, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { customerPricesSchema } from '@vertex-digital/contracts';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import type { CustomerIdentity } from '../auth/index.js';
import { CatalogStoreService } from './catalog-store.service.js';

/**
 * S20 AT4: the signed-in account's own prices for a game, beside the public (retail) catalog.
 * Read from the session only, with no list or customer parameter, and never cached by anyone.
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogPricesController {
  constructor(private readonly store: CatalogStoreService) {}

  @Get('games/:slug/prices')
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @SerializeOptions({ schema: customerPricesSchema })
  @ApiOkResponse({ description: 'The account’s prices', standardSchema: customerPricesSchema })
  prices(@CurrentCustomer() customer: CustomerIdentity, @Param('slug') slug: string) {
    return this.store.customerPrices(customer.id, slug);
  }
}
