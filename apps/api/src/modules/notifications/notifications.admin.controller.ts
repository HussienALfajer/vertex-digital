import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AdminRoute, AdminSessionCheck } from '../../core/access/index.js';
import { NotificationStreamService } from './notification-stream.service.js';

/** The admin's live stream (S11 rule LR4): order events for the live room and the dashboard. */
@ApiTags('notifications')
@Controller('admin')
export class NotificationsAdminController {
  constructor(private readonly streams: NotificationStreamService) {}

  @Get('stream')
  @AdminRoute()
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: 'Server-sent events: `order` `{ orderId, status }` and `resync` (rule LR4)',
  })
  stream(
    @AdminSessionCheck() sessionValid: () => Promise<boolean>,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.streams.openAdmin(sessionValid, request, response);
  }
}
