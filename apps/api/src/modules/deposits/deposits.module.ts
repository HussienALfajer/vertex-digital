import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { FilesModule } from '../files/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { RatesModule } from '../rates/index.js';
import { SettingsModule } from '../settings/index.js';
import { WalletModule } from '../wallet/index.js';
import { DepositReviewService } from './deposit-review.service.js';
import { DepositSettingsService } from './deposit-settings.service.js';
import { DepositsAdminController } from './deposits.admin.controller.js';
import { DepositsController } from './deposits.controller.js';
import { DepositsService } from './deposits.service.js';
import { UsdtDepositsService } from './usdt-deposits.service.js';
import { UsdtReviewService } from './usdt-review.service.js';

/**
 * Deposits (S03, F05; S04, F06): `deposits`, `deposit_receipts`, `deposit_flags`,
 * `deposit_settings`, and the USDT tables `usdt_deposits`, `usdt_transfers`, `usdt_scan_cursors`.
 * The customer's Sham Cash and USDT deposits and the admin's review. Credits post through the
 * ledger write paths in `packages/db`; the customer's balance comes from the wallet module.
 */
@Module({
  imports: [
    AuthModule,
    AdminModule,
    FilesModule,
    NotificationsModule,
    RatesModule,
    SettingsModule,
    WalletModule,
  ],
  controllers: [DepositsController, DepositsAdminController],
  providers: [
    DepositsService,
    DepositReviewService,
    DepositSettingsService,
    UsdtDepositsService,
    UsdtReviewService,
  ],
})
export class DepositsModule {}
