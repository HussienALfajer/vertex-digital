import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { FilesModule } from '../files/index.js';
import { RatesModule } from '../rates/index.js';
import { CatalogAdminController } from './catalog.admin.controller.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CatalogItemsAdminController } from './catalog-items.admin.controller.js';
import { CatalogItemsService } from './catalog-items.service.js';

/**
 * The catalog (S06, F08): `catalog_categories`, `catalog_games`, `catalog_input_fields`,
 * `catalog_products`, and the public catalog images. `pricing` reads product paths and targets
 * through `CatalogService`; the catalog never imports `pricing` or `suppliers`: products show their
 * price and availability (S07) from the routing state `packages/db` reads.
 */
@Module({
  imports: [AdminModule, FilesModule, RatesModule],
  controllers: [CatalogController, CatalogAdminController, CatalogItemsAdminController],
  providers: [CatalogService, CatalogItemsService],
  exports: [CatalogService, CatalogItemsService],
})
export class CatalogModule {}
