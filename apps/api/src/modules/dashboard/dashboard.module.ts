import { Module } from '@nestjs/common';
import { DepositsModule } from '../deposits/index.js';
import { HealthModule } from '../health/index.js';
import { MerchantsModule } from '../merchants/index.js';
import { OrdersModule } from '../orders/index.js';
import { PricingModule } from '../pricing/index.js';
import { RatesModule } from '../rates/index.js';
import { ReconciliationModule } from '../reconciliation/index.js';
import { SettingsModule } from '../settings/index.js';
import { SuppliersModule } from '../suppliers/index.js';
import { SupportModule } from '../support/index.js';
import { TelegramModule } from '../telegram/index.js';
import { DashboardAdminController } from './dashboard.admin.controller.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The panel's home page (S11, F18): a read module above `orders`, `deposits`, `suppliers`,
 * `pricing`, `rates`, `reconciliation`, `settings`, `support`, `telegram`, (S20) `merchants` and
 * (audit A10-53) `health`, reading each through its service. Owns no table.
 */
@Module({
  imports: [
    DepositsModule,
    HealthModule,
    MerchantsModule,
    OrdersModule,
    PricingModule,
    RatesModule,
    ReconciliationModule,
    SettingsModule,
    SuppliersModule,
    SupportModule,
    TelegramModule,
  ],
  controllers: [DashboardAdminController],
  providers: [DashboardService],
})
export class DashboardModule {}
