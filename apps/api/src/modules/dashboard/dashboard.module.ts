import { Module } from '@nestjs/common';
import { DepositsModule } from '../deposits/index.js';
import { OrdersModule } from '../orders/index.js';
import { PricingModule } from '../pricing/index.js';
import { RatesModule } from '../rates/index.js';
import { SettingsModule } from '../settings/index.js';
import { SuppliersModule } from '../suppliers/index.js';
import { TelegramModule } from '../telegram/index.js';
import { DashboardAdminController } from './dashboard.admin.controller.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The panel's home page (S11, F18): a read module above `orders`, `deposits`, `suppliers`,
 * `pricing`, `rates`, `settings` and `telegram`, reading each through its service. Owns no table.
 */
@Module({
  imports: [
    DepositsModule,
    OrdersModule,
    PricingModule,
    RatesModule,
    SettingsModule,
    SuppliersModule,
    TelegramModule,
  ],
  controllers: [DashboardAdminController],
  providers: [DashboardService],
})
export class DashboardModule {}
