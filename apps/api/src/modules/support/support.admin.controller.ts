import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  SerializeOptions,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  type AdminTicketListQuery,
  adminCreateTicketSchema,
  adminTicketListQuerySchema,
  adminTicketPageSchema,
  adminTicketSchema,
  type SupportSettings,
  supportSettingsSchema,
  ticketMessageSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { sendImage } from '../files/index.js';
import { SupportAdminService } from './support-admin.service.js';
import { ticketBody, ticketUpload, type Uploads } from './ticket-upload.js';

/**
 * The admin's support (S12 F23): the queue and threads, replies, closes, tickets opened to a
 * customer, and the support settings (re-authentication to change, SC1).
 */
@ApiTags('support')
@Controller('admin/support')
export class SupportAdminController {
  constructor(private readonly support: SupportAdminService) {}

  @Get('tickets')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(adminTicketListQuerySchema)
  @SerializeOptions({ schema: adminTicketPageSchema })
  @ApiOkResponse({ description: 'The queue (TK12)', standardSchema: adminTicketPageSchema })
  queue(@Query({ schema: adminTicketListQuerySchema }) query: AdminTicketListQuery) {
    return this.support.queue(query);
  }

  @Post('tickets')
  @AdminRoute()
  @UseInterceptors(ticketUpload)
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(
    ticketBody({
      customerId: { type: 'string', format: 'uuid' },
      category: { type: 'string', enum: ['order', 'deposit', 'account', 'other'] },
      orderId: { type: 'string', format: 'uuid' },
      depositId: { type: 'string', format: 'uuid' },
      subject: { type: 'string' },
      body: { type: 'string' },
    }),
  )
  @SerializeOptions({ schema: adminTicketSchema })
  @ApiCreatedResponse({ description: 'Opened (200: a replay)', standardSchema: adminTicketSchema })
  async open(
    @CurrentAdmin() admin: AdminIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: Uploads,
    @Body({ schema: adminCreateTicketSchema }) body: z.output<typeof adminCreateTicketSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { ticket, created } = await this.support.open(
      admin.id,
      idempotencyKey,
      body,
      (files ?? []).map((file) => file.buffer),
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return ticket;
  }

  @Get('tickets/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminTicketSchema })
  @ApiOkResponse({
    description: 'The thread and its side panel',
    standardSchema: adminTicketSchema,
  })
  ticket(@Param('id') id: string) {
    return this.support.ticket(id);
  }

  @Post('tickets/:id/messages')
  @AdminRoute()
  @UseInterceptors(ticketUpload)
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(ticketBody({ body: { type: 'string' } }))
  @SerializeOptions({ schema: adminTicketSchema })
  @ApiCreatedResponse({ description: 'Sent (200: a replay)', standardSchema: adminTicketSchema })
  async reply(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: Uploads,
    @Body({ schema: ticketMessageSchema }) body: z.output<typeof ticketMessageSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { ticket, created } = await this.support.reply(
      admin.id,
      id,
      idempotencyKey,
      body.body,
      (files ?? []).map((file) => file.buffer),
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return ticket;
  }

  @Post('tickets/:id/close')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminTicketSchema })
  @ApiOkResponse({ description: 'Closed', standardSchema: adminTicketSchema })
  close(@CurrentAdmin() admin: AdminIdentity, @Param('id') id: string, @Req() request: Request) {
    return this.support.close(admin.id, id, requestMeta(request));
  }

  @Get('tickets/:id/attachments/:fileId')
  @AdminRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'An image of the ticket (TK11)' })
  async attachment(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(response, await this.support.attachment(id, fileId), 'no-store');
  }

  @Get('settings')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supportSettingsSchema })
  @ApiOkResponse({ description: 'The support settings', standardSchema: supportSettingsSchema })
  settings() {
    return this.support.settings();
  }

  @Put('settings')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supportSettingsSchema })
  @ApiOkResponse({ description: 'Saved (SC1)', standardSchema: supportSettingsSchema })
  updateSettings(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: supportSettingsSchema }) body: SupportSettings,
    @Req() request: Request,
  ) {
    return this.support.updateSettings(admin.id, body, requestMeta(request));
  }
}
