import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { CatalogModule } from '../catalog/index.js';
import { RoutesAdminController } from './routes.admin.controller.js';
import { RoutesService } from './routes.service.js';
import { SuppliersAdminController } from './suppliers.admin.controller.js';
import { SuppliersService } from './suppliers.service.js';

/**
 * Suppliers (S07, F09): `suppliers`, their credentials, offers, cost changes, sync runs, calls,
 * health, balances, the policy, and `product_routes`. Above `catalog` (products, fields, the
 * import's products); prices follow through the repricing path of `packages/db`. The sync,
 * balances and health are worker jobs.
 */
@Module({
  imports: [AdminModule, CatalogModule],
  controllers: [SuppliersAdminController, RoutesAdminController],
  providers: [SuppliersService, RoutesService],
})
export class SuppliersModule {}
