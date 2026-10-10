import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AdminRoute, AdminSessionCheck, NoActivity } from '../../core/access/index.js';
import { NotificationStreamService } from './notification-stream.service.js';

/** The admin's live stream (S11 rule LR4): order events for the live room and the dashboard. */
@ApiTags('notifications')
@Controller('admin')
export class NotificationsAdminController {
  constructor(private readonly streams: NotificationStreamService) {}

  @Get('stream')
  @AdminRoute()
  // Connects and the browser's own reconnects never keep an unattended panel signed in.
  @NoActivity()
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description:
      'Server-sent events: `order` `{ orderId, status }`, `resync`, and `replaced` before a newer stream closes this one (rule LR4)',
  })
  stream(
    @AdminSessionCheck() sessionValid: () => Promise<boolean>,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.streams.openAdmin(sessionValid, request, response);
  }
}
