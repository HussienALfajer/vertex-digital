import { Module } from '@nestjs/common';
import { FilesModule } from '../files/index.js';
import { OrdersModule } from '../orders/index.js';
import { RatesModule } from '../rates/index.js';
import { MerchantCounterController } from './merchant-counter.controller.js';
import { MerchantCounterService } from './merchant-counter.service.js';
import { MerchantToolsController } from './merchant-tools.controller.js';
import { MerchantToolsService } from './merchant-tools.service.js';

/**
 * The merchant area (S21 F30–F35; ADR 0036): `merchant_selling_settings`,
 * `merchant_selling_prices`, `merchant_order_sales`, `merchant_watches`, `merchant_watch_states`,
 * `merchant_alert_events`, `merchant_alert_settings`, `merchant_receipt_settings`. Sale rows are
 * written by the order write path in `packages/db` (in the purchase's transaction), the alerts by
 * the worker; levels belong to `merchants`. PR 2: the counter tools (`merchant-counter.service.ts`:
 * recent ids, the bulk check through `PlayerChecksService`, receipt settings and logo, an order's
 * sale). Above `rates`, `files` and `orders`.
 */
@Module({
  imports: [FilesModule, OrdersModule, RatesModule],
  controllers: [MerchantToolsController, MerchantCounterController],
  providers: [MerchantToolsService, MerchantCounterService],
})
export class MerchantToolsModule {}
