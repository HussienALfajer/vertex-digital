import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
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
  createTicketSchema,
  ORDER_PROBLEMS,
  supportChannelsSchema,
  type TicketListQuery,
  ticketListQuerySchema,
  ticketMessageSchema,
  ticketPageSchema,
  ticketSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentCustomer, CustomerRoute, Public } from '../../core/access/index.js';
import { RequireAltcha } from '../../core/altcha/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { sendImage } from '../files/index.js';
import { SupportService } from './support.service.js';
import { ticketBody, ticketUpload, type Uploads } from './ticket-upload.js';

/**
 * The customer's tickets (S12 F23) and the public support channels. Never cached but the
 * channels; another customer's ticket or image answers `404`.
 */
@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('channels')
  @Public()
  @Header('cache-control', 'public, max-age=60')
  @SerializeOptions({ schema: supportChannelsSchema })
  @ApiOkResponse({ description: 'The support links (SC2)', standardSchema: supportChannelsSchema })
  channels() {
    return this.support.channels();
  }

  @Get('tickets')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(ticketListQuerySchema)
  @SerializeOptions({ schema: ticketPageSchema })
  @ApiOkResponse({ description: 'Newest activity first', standardSchema: ticketPageSchema })
  list(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: ticketListQuerySchema }) query: TicketListQuery,
  ) {
    return this.support.list(customer.id, query);
  }

  @Post('tickets')
  @CustomerRoute()
  @RequireAltcha()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @UseInterceptors(ticketUpload)
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(
    ticketBody({
      category: { type: 'string', enum: ['order', 'deposit', 'account', 'other'] },
      orderId: { type: 'string', format: 'uuid' },
      depositId: { type: 'string', format: 'uuid' },
      subject: { type: 'string' },
      body: { type: 'string' },
      // S22 OP5: an order ticket from a problem button names the problem.
      orderProblem: { type: 'string', enum: [...ORDER_PROBLEMS] },
    }),
  )
  @SerializeOptions({ schema: ticketSchema })
  @ApiCreatedResponse({ description: 'Opened (200: a replay)', standardSchema: ticketSchema })
  async open(
    @CurrentCustomer() customer: CustomerIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: Uploads,
    @Body({ schema: createTicketSchema }) body: z.output<typeof createTicketSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { ticket, created } = await this.support.open(
      customer.id,
      idempotencyKey,
      body,
      (files ?? []).map((file) => file.buffer),
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return ticket;
  }

  @Get('tickets/:id')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: ticketSchema })
  @ApiOkResponse({ description: 'The thread, oldest first', standardSchema: ticketSchema })
  ticket(@CurrentCustomer() customer: CustomerIdentity, @Param('id') id: string) {
    return this.support.ticket(customer.id, id);
  }

  @Post('tickets/:id/messages')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @UseInterceptors(ticketUpload)
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(ticketBody({ body: { type: 'string' } }))
  @SerializeOptions({ schema: ticketSchema })
  @ApiCreatedResponse({ description: 'Sent (200: a replay)', standardSchema: ticketSchema })
  async reply(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: Uploads,
    @Body({ schema: ticketMessageSchema }) body: z.output<typeof ticketMessageSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { ticket, created } = await this.support.reply(
      customer.id,
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
  @CustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: ticketSchema })
  @ApiOkResponse({ description: 'Closed', standardSchema: ticketSchema })
  close(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.support.close(customer.id, id, requestMeta(request));
  }

  @Get('tickets/:id/attachments/:fileId')
  @CustomerRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'An image of the ticket (TK11)' })
  async attachment(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(response, await this.support.attachment(customer.id, id, fileId), 'no-store');
  }
}
