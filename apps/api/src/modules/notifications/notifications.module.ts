import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';

/** The email outbox (S01): owns `email_outbox`. Notification preferences arrive with S05 (F27). */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
