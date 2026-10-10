import { Module } from '@nestjs/common';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import { NotificationStreamService } from './notification-stream.service.js';
import { NotificationsAdminController } from './notifications.admin.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/**
 * The email outbox (S01) and the customer notification center (S05 F27): owns `email_outbox`,
 * `customer_notifications` and `notification_preferences`. Below the domain modules, which call
 * `NotificationsService` in their transactions. S11: the admin's stream of order events.
 */
@Module({
  controllers: [
    NotificationsController,
    NotificationPreferencesController,
    NotificationsAdminController,
  ],
  providers: [NotificationsService, NotificationStreamService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
