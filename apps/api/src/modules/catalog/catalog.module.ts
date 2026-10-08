import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { FilesModule } from '../files/index.js';
import { CatalogAdminController } from './catalog.admin.controller.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CatalogItemsAdminController } from './catalog-items.admin.controller.js';
import { CatalogItemsService } from './catalog-items.service.js';

/**
 * The catalog (S06, F08): `catalog_categories`, `catalog_games`, `catalog_input_fields`,
 * `catalog_products`, and the public catalog images. `pricing` reads product paths and targets
 * through `CatalogService`; the catalog never imports `pricing`.
 */
@Module({
  imports: [AdminModule, FilesModule],
  controllers: [CatalogController, CatalogAdminController, CatalogItemsAdminController],
  providers: [CatalogService, CatalogItemsService],
  exports: [CatalogService],
})
export class CatalogModule {}
