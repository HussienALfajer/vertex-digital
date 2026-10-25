import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { FilesModule } from '../files/index.js';
import { RatesModule } from '../rates/index.js';
import { CatalogAdminController } from './catalog.admin.controller.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CatalogItemsAdminController } from './catalog-items.admin.controller.js';
import { CatalogItemsService } from './catalog-items.service.js';
import { CatalogPricesController } from './catalog-prices.controller.js';
import { CatalogStoreService } from './catalog-store.service.js';
import { ProductAlertsController } from './product-alerts.controller.js';
import { ProductAlertsService } from './product-alerts.service.js';
import { QuickLinksAdminController } from './quick-links.admin.controller.js';
import { QuickLinksController } from './quick-links.controller.js';
import { QuickLinksService } from './quick-links.service.js';

/**
 * The catalog (S06, F08): `catalog_categories`, `catalog_games`, `catalog_input_fields`,
 * `catalog_products`, the public catalog images and (S22) the direct buy links' `quick_link_events` and the product alerts' `product_alerts`. `pricing` reads product paths and targets
 * through `CatalogService`; the catalog never imports `pricing` or `suppliers`: products show their
 * price and availability (S07) from the routing state `packages/db` reads.
 */
@Module({
  imports: [AdminModule, FilesModule, RatesModule],
  controllers: [
    CatalogController,
    CatalogPricesController,
    CatalogAdminController,
    CatalogItemsAdminController,
    QuickLinksController,
    QuickLinksAdminController,
    ProductAlertsController,
  ],
  providers: [
    CatalogService,
    CatalogItemsService,
    CatalogStoreService,
    QuickLinksService,
    ProductAlertsService,
  ],
  exports: [CatalogService, CatalogItemsService],
})
export class CatalogModule {}
