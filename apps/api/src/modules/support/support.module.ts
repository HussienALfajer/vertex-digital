import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { FilesModule } from '../files/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { ShopsModule } from '../shops/index.js';
import { SupportAdminController } from './support.admin.controller.js';
import { SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';
import { SupportAdminService } from './support-admin.service.js';
import { SupportShopController } from './support-shop.controller.js';
import { SupportShopService } from './support-shop.service.js';

/**
 * Support tickets and channels (S12 F23): `support_tickets`, `support_messages`,
 * `support_attachments`, `support_settings`. A ticket's order or deposit is read through
 * `packages/db/src/support`; the customer is told through the notifications module, the admin
 * through the Telegram outbox. The dashboard reads the waiting count through
 * `SupportAdminService`. S26 TK1–TK5: shop tickets for the shop customer and the merchant, the
 * shop read through the shops module.
 */
@Module({
  imports: [AuthModule, AdminModule, FilesModule, NotificationsModule, ShopsModule],
  controllers: [SupportController, SupportAdminController, SupportShopController],
  providers: [SupportService, SupportAdminService, SupportShopService],
  exports: [SupportAdminService],
})
export class SupportModule {}
