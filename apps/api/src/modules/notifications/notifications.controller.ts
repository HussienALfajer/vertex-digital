import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  SerializeOptions,
} from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type MarkNotificationsRead,
  markNotificationsReadSchema,
  type NotificationListQuery,
  notificationListQuerySchema,
  notificationPageSchema,
  unreadCountSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { CurrentCustomer, CustomerRoute, CustomerSessionCheck } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import type { CustomerIdentity } from '../auth/index.js';
import { NotificationStreamService } from './notification-stream.service.js';
import { NotificationsService } from './notifications.service.js';

/** The customer's notification center (S05 rules NT5, NT6): own notifications only, never cached. */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly streams: NotificationStreamService,
  ) {}

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(notificationListQuerySchema)
  @SerializeOptions({ schema: notificationPageSchema })
  @ApiOkResponse({
    description: 'Newest first, with the unread count',
    standardSchema: notificationPageSchema,
  })
  list(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: notificationListQuerySchema }) query: NotificationListQuery,
  ) {
    return this.notifications.list(customer.id, query);
  }

  @Post('read')
  @CustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: unreadCountSchema })
  @ApiOkResponse({ description: 'Read up to this notification', standardSchema: unreadCountSchema })
  read(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: markNotificationsReadSchema }) body: MarkNotificationsRead,
  ) {
    return this.notifications.markRead(customer.id, body.upToId);
  }

  @Get('stream')
  @CustomerRoute()
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: 'Server-sent events: `unread`, `notification` and `resync` (rule NT6)',
  })
  stream(
    @CurrentCustomer() customer: CustomerIdentity,
    @CustomerSessionCheck() sessionValid: () => Promise<boolean>,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.streams.open(customer.id, sessionValid, request, response);
  }
}
