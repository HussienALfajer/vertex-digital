import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { FilesModule } from '../files/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { RatesModule } from '../rates/index.js';
import { WalletModule } from '../wallet/index.js';
import { DepositReviewService } from './deposit-review.service.js';
import { DepositSettingsService } from './deposit-settings.service.js';
import { DepositsAdminController } from './deposits.admin.controller.js';
import { DepositsController } from './deposits.controller.js';
import { DepositsService } from './deposits.service.js';

/**
 * Deposits (S03, F05): `deposits`, `deposit_receipts`, `deposit_flags` and `deposit_settings`.
 * The customer's Sham Cash wizard and the admin's review. Credits post through the ledger write
 * path in `packages/db`; the customer's balance comes from the wallet module.
 */
@Module({
  imports: [AuthModule, AdminModule, FilesModule, NotificationsModule, RatesModule, WalletModule],
  controllers: [DepositsController, DepositsAdminController],
  providers: [DepositsService, DepositReviewService, DepositSettingsService],
})
export class DepositsModule {}
