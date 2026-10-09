import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { SettingsModule } from '../settings/index.js';
import { OrderDecisionsService } from './order-decisions.service.js';
import { OrdersAdminController } from './orders.admin.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/**
 * Orders (S08, F11): `orders`, their events, fulfilment attempts, codes and reveals, and the
 * order policy. Above `catalog`, `pricing`, `suppliers`, `wallet` and `settings`: the purchase,
 * outcomes and refunds go through the order write path of `packages/db`, which reads their rows.
 * Routing, sending, polling and webhook processing are worker jobs.
 */
@Module({
  imports: [AdminModule, AuthModule, SettingsModule],
  controllers: [OrdersController, OrdersAdminController],
  providers: [OrdersService, OrderDecisionsService],
  exports: [OrdersService],
})
export class OrdersModule {}
