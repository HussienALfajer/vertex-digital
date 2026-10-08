import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { CatalogModule } from '../catalog/index.js';
import { RatesModule } from '../rates/index.js';
import { PricingAdminController } from './pricing.admin.controller.js';
import { PricingService } from './pricing.service.js';
import { ProductPricesAdminController } from './product-prices.admin.controller.js';

/**
 * The pricing engine (S06, F10): `margin_rules`; S07: `product_prices` and `price_reviews`, written
 * through the repricing path of `packages/db`. Above `catalog` (product paths and targets, the
 * pause of a review) and `rates` (SYP prices).
 */
@Module({
  imports: [AdminModule, CatalogModule, RatesModule],
  controllers: [PricingAdminController, ProductPricesAdminController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
