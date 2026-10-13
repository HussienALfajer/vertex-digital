import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { FilesModule } from '../files/index.js';
import { SettingsModule } from '../settings/index.js';
import { SuppliersModule } from '../suppliers/index.js';
import { AdminPurchasesService } from './admin-purchases.service.js';
import { OrderActionsService } from './order-actions.service.js';
import { OrderDecisionsService } from './order-decisions.service.js';
import { OrdersAdminController } from './orders.admin.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { PlayerChecksAdminController } from './player-checks.admin.controller.js';
import { PlayerChecksService } from './player-checks.service.js';
import { SavedPlayersService } from './saved-players.service.js';
import { ShareLinksService } from './share-links.service.js';
import { SharesController } from './shares.controller.js';

/**
 * Orders (S08, F11): `orders`, their events, fulfilment attempts, codes and reveals, and the
 * order policy. Above `catalog`, `pricing`, `suppliers`, `wallet` and `settings`: the purchase,
 * outcomes and refunds go through the order write path of `packages/db`, which reads their rows.
 * Routing, sending, polling and webhook processing are worker jobs. S10: checkouts, saved player
 * ids and share links, with the public share pages and images (`shares.controller.ts`). S11: the
 * live room and the admin's reroute, delivery proof and manual fulfil (`order-actions.service.ts`).
 * S16: purchases from the panel and the admin's player checks (`admin-purchases.service.ts`).
 */
@Module({
  imports: [AdminModule, AuthModule, FilesModule, SettingsModule, SuppliersModule],
  controllers: [
    OrdersController,
    OrdersAdminController,
    PlayerChecksAdminController,
    SharesController,
  ],
  providers: [
    OrdersService,
    AdminPurchasesService,
    OrderDecisionsService,
    OrderActionsService,
    PlayerChecksService,
    SavedPlayersService,
    ShareLinksService,
  ],
  exports: [OrdersService, OrderActionsService],
})
export class OrdersModule {}
