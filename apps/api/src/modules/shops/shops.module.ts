import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/index.js';
import { CatalogModule } from '../catalog/index.js';
import { FilesModule } from '../files/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { OrdersModule } from '../orders/index.js';
import { SettingsModule } from '../settings/index.js';
import { ShopAccountsService } from './shop-accounts.service.js';
import { ShopAuthService } from './shop-auth.service.js';
import { ShopCustomerController } from './shop-customer.controller.js';
import { ShopCustomersService } from './shop-customers.service.js';
import { ShopMerchantSalesController } from './shop-merchant-sales.controller.js';
import { ShopNotificationsService } from './shop-notifications.service.js';
import { ShopOrdersController } from './shop-orders.controller.js';
import { ShopPublicController } from './shop-public.controller.js';
import { ShopSellingService } from './shop-selling.service.js';
import { ShopStorefrontService } from './shop-storefront.service.js';
import { ShopsAdminController } from './shops.admin.controller.js';
import { ShopsController } from './shops.controller.js';
import { ShopsAdminService } from './shops-admin.service.js';
import { ShopsMerchantService } from './shops-merchant.service.js';

/**
 * Merchant shops (S26, ADR 0040): `merchant_shops`, `merchant_shop_slugs`, `merchant_shop_rates`,
 * `merchant_shop_hidden_games`, the shop customer realm's tables (its own Better Auth instance at
 * `/api/shops/:slug/auth/`), `shop_transfers`, `shop_return_requests`, `shop_settlements`, and (PR 2) `shop_order_sales`,
 * `shop_compensations`, `shop_daily_stats`, the shop customers' notifications and push devices.
 * Money moves through `packages/db` (`shops`, `orders`); above `auth` (the merchant's transfer
 * check), `catalog` (the shop's catalog), `orders` (player checks) and `settings` (switches).
 */
@Module({
  imports: [
    AuthModule,
    CatalogModule,
    FilesModule,
    NotificationsModule,
    OrdersModule,
    SettingsModule,
  ],
  controllers: [
    ShopsController,
    ShopsAdminController,
    ShopCustomerController,
    ShopPublicController,
    ShopOrdersController,
    ShopMerchantSalesController,
  ],
  providers: [
    ShopAccountsService,
    ShopAuthService,
    ShopCustomersService,
    ShopNotificationsService,
    ShopSellingService,
    ShopStorefrontService,
    ShopsAdminService,
    ShopsMerchantService,
  ],
  exports: [ShopAuthService, ShopsMerchantService],
})
export class ShopsModule {}
