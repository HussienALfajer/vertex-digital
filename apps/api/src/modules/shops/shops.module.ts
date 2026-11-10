import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { ShopAccountsService } from './shop-accounts.service.js';
import { ShopAuthService } from './shop-auth.service.js';
import { ShopCustomerController } from './shop-customer.controller.js';
import { ShopCustomersService } from './shop-customers.service.js';
import { ShopsAdminController } from './shops.admin.controller.js';
import { ShopsController } from './shops.controller.js';
import { ShopsAdminService } from './shops-admin.service.js';
import { ShopsMerchantService } from './shops-merchant.service.js';

/**
 * Merchant shops (S26, ADR 0040): `merchant_shops`, `merchant_shop_slugs`, `merchant_shop_rates`,
 * `merchant_shop_hidden_games`, the shop customer realm's tables (its own Better Auth instance at
 * `/api/shops/:slug/auth/`), `shop_transfers`, `shop_return_requests`, `shop_settlements`. Money
 * moves through `packages/db` (`shops`); above `auth` (the merchant's transfer check).
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ShopsController, ShopsAdminController, ShopCustomerController],
  providers: [
    ShopAccountsService,
    ShopAuthService,
    ShopCustomersService,
    ShopsAdminService,
    ShopsMerchantService,
  ],
  exports: [ShopAuthService],
})
export class ShopsModule {}
