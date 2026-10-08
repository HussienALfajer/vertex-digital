// Public surface of the catalog module. Code outside this folder imports from here only.
export { CatalogModule } from './catalog.module.js';
export { CatalogService, type PricingTarget } from './catalog.service.js';
export { CatalogItemsService } from './catalog-items.service.js';
export type { Actor } from './catalog-records.js';
