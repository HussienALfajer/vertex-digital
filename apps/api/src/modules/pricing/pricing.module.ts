import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { CatalogModule } from '../catalog/index.js';
import { RatesModule } from '../rates/index.js';
import { PricingAdminController } from './pricing.admin.controller.js';
import { PricingService } from './pricing.service.js';

/**
 * The pricing engine (S06, F10): `margin_rules`. Above `catalog` (product paths and targets) and
 * `rates` (SYP prices); S07's `suppliers` module calls `PricingService` to price products.
 */
@Module({
  imports: [AdminModule, CatalogModule, RatesModule],
  controllers: [PricingAdminController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
