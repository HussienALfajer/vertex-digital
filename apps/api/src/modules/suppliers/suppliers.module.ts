import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { CatalogModule } from '../catalog/index.js';
import { RoutesAdminController } from './routes.admin.controller.js';
import { RoutesService } from './routes.service.js';
import { SupplierWebhooksController } from './supplier-webhooks.controller.js';
import { SupplierWebhooksService } from './supplier-webhooks.service.js';
import { SuppliersAdminController } from './suppliers.admin.controller.js';
import { SuppliersService } from './suppliers.service.js';

/**
 * Suppliers (S07, F09): `suppliers`, their credentials, offers, cost changes, sync runs, calls,
 * health, balances, the policy, `product_routes`, and (S08) the webhook events of order results. Above `catalog` (products, fields, the
 * import's products); prices follow through the repricing path of `packages/db`. The sync,
 * balances and health are worker jobs.
 */
@Module({
  imports: [AdminModule, CatalogModule],
  controllers: [SuppliersAdminController, RoutesAdminController, SupplierWebhooksController],
  providers: [SuppliersService, RoutesService, SupplierWebhooksService],
})
export class SuppliersModule {}
