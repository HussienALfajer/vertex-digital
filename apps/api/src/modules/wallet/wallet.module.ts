import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { RatesModule } from '../rates/index.js';
import { WalletAdminController } from './wallet.admin.controller.js';
import { WalletController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';
import { WalletAdjustmentsService } from './wallet-adjustments.service.js';

/**
 * Wallets (S02, F03): the ledger tables and `wallet_adjustments`. The customer's balance and
 * timeline, the admin's wallet screens, adjustments, reversals and the ledger summary.
 */
@Module({
  imports: [AuthModule, AdminModule, NotificationsModule, RatesModule],
  controllers: [WalletController, WalletAdminController],
  providers: [WalletService, WalletAdjustmentsService],
  exports: [WalletService],
})
export class WalletModule {}
