import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { CustomersModule } from '../customers/index.js';
import { DepositsModule } from '../deposits/index.js';
import { FilesModule } from '../files/index.js';
import { MerchantTierController } from './merchant-tier.controller.js';
import { MerchantTierService } from './merchant-tier.service.js';
import { MerchantTiersAdminController } from './merchant-tiers.admin.controller.js';
import { MerchantTiersService } from './merchant-tiers.service.js';
import { MerchantsAdminController } from './merchants.admin.controller.js';
import { MerchantsController } from './merchants.controller.js';
import { MerchantsService } from './merchants.service.js';
import { MerchantsAdminService } from './merchants-admin.service.js';

/**
 * Merchant accounts (S20 F28): `merchant_applications`, `merchant_application_events`,
 * `merchant_shop_photos`, `merchant_profiles`, `merchant_settings`. The account's type and list
 * are the `auth` module's columns, changed through `packages/db/src/merchants` with the customer
 * locked; the answers of a grant and a revocation are the customer profile of `customers`. Above
 * `customers` and `deposits` (the minimums the limits must reach). The dashboard reads the waiting
 * count through `MerchantsAdminService`. S21 F39, S23 F43: `merchant_levels` (one per tier
 * above Bronze), `merchant_tier_settings`, `merchant_tier_grants`, `merchant_tier_changes`,
 * `merchant_tier_months` (the panel's tiers and grants; the recomputation is the worker's
 * `merchants.level`). S23 PR 2: the merchant's tier card, table, history, celebration and
 * certificate, and the certificate's public page (`merchant-tier.service.ts`).
 */
@Module({
  imports: [AuthModule, AdminModule, CustomersModule, DepositsModule, FilesModule],
  controllers: [
    MerchantsController,
    MerchantTierController,
    MerchantsAdminController,
    MerchantTiersAdminController,
  ],
  providers: [MerchantsService, MerchantsAdminService, MerchantTiersService, MerchantTierService],
  exports: [MerchantsAdminService],
})
export class MerchantsModule {}
