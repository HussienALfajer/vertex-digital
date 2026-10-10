import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { FilesModule } from '../files/index.js';
import { SettingsModule } from '../settings/index.js';
import { SuppliersModule } from '../suppliers/index.js';
import { OrderDecisionsService } from './order-decisions.service.js';
import { OrdersAdminController } from './orders.admin.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { PlayerChecksService } from './player-checks.service.js';
import { SavedPlayersService } from './saved-players.service.js';
import { ShareLinksService } from './share-links.service.js';
import { SharesController } from './shares.controller.js';

/**
 * Orders (S08, F11): `orders`, their events, fulfilment attempts, codes and reveals, and the
 * order policy. Above `catalog`, `pricing`, `suppliers`, `wallet` and `settings`: the purchase,
 * outcomes and refunds go through the order write path of `packages/db`, which reads their rows.
 * Routing, sending, polling and webhook processing are worker jobs. S10: checkouts, saved player
 * ids and share links, with the public share pages and images (`shares.controller.ts`).
 */
@Module({
  imports: [AdminModule, AuthModule, FilesModule, SettingsModule, SuppliersModule],
  controllers: [OrdersController, OrdersAdminController, SharesController],
  providers: [
    OrdersService,
    OrderDecisionsService,
    PlayerChecksService,
    SavedPlayersService,
    ShareLinksService,
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
