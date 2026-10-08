import { Body, Controller, Get, Header, Put, Req, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  notificationPreferencesSchema,
  type UpdateNotificationPreference,
  updateNotificationPreferenceSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { CustomerIdentity } from '../auth/index.js';
import { NotificationsService } from './notifications.service.js';

/** The customer's email choices (S05 rule NT8), on `/account`. */
@ApiTags('notifications')
@Controller('account/notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: notificationPreferencesSchema })
  @ApiOkResponse({
    description: 'The email choice per event',
    standardSchema: notificationPreferencesSchema,
  })
  preferences(@CurrentCustomer() customer: CustomerIdentity) {
    return this.notifications.preferences(customer.id);
  }

  @Put()
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: notificationPreferencesSchema })
  @ApiOkResponse({
    description: 'The choice is saved',
    standardSchema: notificationPreferencesSchema,
  })
  update(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: updateNotificationPreferenceSchema }) body: UpdateNotificationPreference,
    @Req() request: Request,
  ) {
    return this.notifications.setPreference(customer.id, body, requestMeta(request));
  }
}
