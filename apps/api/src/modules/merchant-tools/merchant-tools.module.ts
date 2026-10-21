import { Module } from '@nestjs/common';
import { RatesModule } from '../rates/index.js';
import { MerchantToolsController } from './merchant-tools.controller.js';
import { MerchantToolsService } from './merchant-tools.service.js';

/**
 * The merchant area (S21 F30, F31, F37; ADR 0036): `merchant_selling_settings`,
 * `merchant_selling_prices`, `merchant_order_sales`, `merchant_watches`, `merchant_watch_states`,
 * `merchant_alert_events`, `merchant_alert_settings`. Sale rows are written by the order write path
 * in `packages/db` (in the purchase's transaction), the alerts by the worker; levels belong to
 * `merchants`. Above `rates`.
 */
@Module({
  imports: [RatesModule],
  controllers: [MerchantToolsController],
  providers: [MerchantToolsService],
})
export class MerchantToolsModule {}
