import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { CatalogModule } from '../catalog/index.js';
import { PricingModule } from '../pricing/index.js';
import { RoutesAdminController } from './routes.admin.controller.js';
import { RoutesService } from './routes.service.js';
import { SupplierAdaptersService } from './supplier-adapters.service.js';
import { SupplierCatalogAdminController } from './supplier-catalog.admin.controller.js';
import { SupplierCatalogService } from './supplier-catalog.service.js';
import { SupplierLiveService } from './supplier-live.service.js';
import { SupplierWebhooksController } from './supplier-webhooks.controller.js';
import { SupplierWebhooksService } from './supplier-webhooks.service.js';
import { SuppliersAdminController } from './suppliers.admin.controller.js';
import { SuppliersService } from './suppliers.service.js';

/**
 * Suppliers (S07, F09): `suppliers`, their credentials, offers, cost changes, sync runs, calls,
 * health, balances, the policy, `product_routes`, (S08) the webhook events of order results and (S16) the category mirror with its imports, links and live reads. Above `catalog` and `pricing` (products, fields, the
 * import's products); prices follow through the repricing path of `packages/db`. The sync,
 * balances and health are worker jobs.
 */
@Module({
  imports: [AdminModule, CatalogModule, PricingModule],
  controllers: [
    SuppliersAdminController,
    RoutesAdminController,
    SupplierWebhooksController,
    SupplierCatalogAdminController,
  ],
  providers: [
    SuppliersService,
    RoutesService,
    SupplierWebhooksService,
    SupplierAdaptersService,
    SupplierCatalogService,
    SupplierLiveService,
  ],
  exports: [SupplierAdaptersService, SuppliersService, SupplierLiveService],
})
export class SuppliersModule {}
