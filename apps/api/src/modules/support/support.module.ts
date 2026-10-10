import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { FilesModule } from '../files/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { SupportAdminController } from './support.admin.controller.js';
import { SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';
import { SupportAdminService } from './support-admin.service.js';

/**
 * Support tickets and channels (S12 F23): `support_tickets`, `support_messages`,
 * `support_attachments`, `support_settings`. A ticket's order or deposit is read through
 * `packages/db/src/support`; the customer is told through the notifications module, the admin
 * through the Telegram outbox. The dashboard reads the waiting count through
 * `SupportAdminService`.
 */
@Module({
  imports: [AuthModule, AdminModule, FilesModule, NotificationsModule],
  controllers: [SupportController, SupportAdminController],
  providers: [SupportService, SupportAdminService],
  exports: [SupportAdminService],
})
export class SupportModule {}
