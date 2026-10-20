import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { CustomersModule } from '../customers/index.js';
import { DepositsModule } from '../deposits/index.js';
import { FilesModule } from '../files/index.js';
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
 * count through `MerchantsAdminService`.
 */
@Module({
  imports: [AuthModule, AdminModule, CustomersModule, DepositsModule, FilesModule],
  controllers: [MerchantsController, MerchantsAdminController],
  providers: [MerchantsService, MerchantsAdminService],
  exports: [MerchantsAdminService],
})
export class MerchantsModule {}
