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
  merchantShopTicketPageSchema,
  merchantShopTicketSchema,
  ORDER_PROBLEMS,
  shopTicketEscalationSchema,
  shopTicketPageSchema,
  shopTicketSchema,
  type TicketListQuery,
  ticketListQuerySchema,
  ticketMessageSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  CurrentCustomer,
  CurrentShopCustomer,
  CustomerRoute,
  ShopCustomerRoute,
} from '../../core/access/index.js';
import { RequireAltcha } from '../../core/altcha/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { sendImage } from '../files/index.js';
import type { ShopCustomerIdentity } from '../shops/index.js';
import { SupportShopService } from './support-shop.service.js';
import { ticketBody, ticketUpload, type Uploads } from './ticket-upload.js';

/**
 * Shop tickets (S26 TK1–TK5): the shop customer's under `/api/shops/:slug/tickets` and the
 * merchant's "تذاكر المتجر" under `/api/merchant/shop/tickets`. Never cached; another customer's
 * or another shop's ticket or image answers `404`.
 */
@ApiTags('support')
@Controller()
export class SupportShopController {
  constructor(private readonly support: SupportShopService) {}

  @Get('shops/:slug/tickets')
  @ShopCustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(ticketListQuerySchema)
  @SerializeOptions({ schema: shopTicketPageSchema })
  @ApiOkResponse({ description: 'Newest activity first', standardSchema: shopTicketPageSchema })
  list(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Query({ schema: ticketListQuerySchema }) query: TicketListQuery,
  ) {
    return this.support.list(customer, query);
  }

  @Post('shops/:slug/tickets')
  @ShopCustomerRoute()
  @RequireAltcha()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @UseInterceptors(ticketUpload)
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(
    ticketBody({
      category: { type: 'string', enum: ['order', 'account', 'other'] },
      orderId: { type: 'string', format: 'uuid' },
      subject: { type: 'string' },
      body: { type: 'string' },
      orderProblem: { type: 'string', enum: [...ORDER_PROBLEMS] },
    }),
  )
  @SerializeOptions({ schema: shopTicketSchema })
  @ApiCreatedResponse({ description: 'Opened (200: a replay)', standardSchema: shopTicketSchema })
  async open(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: Uploads,
    @Body({ schema: createTicketSchema }) body: z.output<typeof createTicketSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { ticket, created } = await this.support.open(
      customer,
      idempotencyKey,
      body,
      (files ?? []).map((file) => file.buffer),
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return ticket;
  }

  @Get('shops/:slug/tickets/:id')
  @ShopCustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: shopTicketSchema })
  @ApiOkResponse({ description: 'The thread, oldest first', standardSchema: shopTicketSchema })
  ticket(@CurrentShopCustomer() customer: ShopCustomerIdentity, @Param('id') id: string) {
    return this.support.ticket(customer, id);
  }

  @Post('shops/:slug/tickets/:id/messages')
  @ShopCustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @UseInterceptors(ticketUpload)
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(ticketBody({ body: { type: 'string' } }))
  @SerializeOptions({ schema: shopTicketSchema })
  @ApiCreatedResponse({ description: 'Sent (200: a replay)', standardSchema: shopTicketSchema })
  async reply(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: Uploads,
    @Body({ schema: ticketMessageSchema }) body: z.output<typeof ticketMessageSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { ticket, created } = await this.support.reply(
      customer,
      id,
      idempotencyKey,
      body.body,
      (files ?? []).map((file) => file.buffer),
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return ticket;
  }

  /** TK2: "طلب تدخل الإدارة", 24 hours after the customer's last message without a reply. */
  @Post('shops/:slug/tickets/:id/escalate')
  @ShopCustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: shopTicketSchema })
  @ApiOkResponse({ description: 'Sent to the store’s support', standardSchema: shopTicketSchema })
  escalate(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.support.escalateByCustomer(customer, id, requestMeta(request));
  }

  @Get('shops/:slug/tickets/:id/attachments/:fileId')
  @ShopCustomerRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'An image of the ticket' })
  async attachment(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(response, await this.support.attachment(customer, id, fileId), 'no-store');
  }

  @Get('merchant/shop/tickets')
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @ApiQueryOf(ticketListQuerySchema)
  @SerializeOptions({ schema: merchantShopTicketPageSchema })
  @ApiOkResponse({
    description: 'Newest activity first',
    standardSchema: merchantShopTicketPageSchema,
  })
  merchantList(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Query({ schema: ticketListQuerySchema }) query: TicketListQuery,
  ) {
    return this.support.merchantList(merchant.id, query);
  }

  @Get('merchant/shop/tickets/:id')
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @SerializeOptions({ schema: merchantShopTicketSchema })
  @ApiOkResponse({ description: 'The thread', standardSchema: merchantShopTicketSchema })
  merchantTicket(@CurrentCustomer() merchant: CustomerIdentity, @Param('id') id: string) {
    return this.support.merchantTicket(merchant.id, id);
  }

  @Post('merchant/shop/tickets/:id/messages')
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @UseInterceptors(ticketUpload)
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(ticketBody({ body: { type: 'string' } }))
  @SerializeOptions({ schema: merchantShopTicketSchema })
  @ApiCreatedResponse({
    description: 'Sent (200: a replay)',
    standardSchema: merchantShopTicketSchema,
  })
  async merchantReply(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: Uploads,
    @Body({ schema: ticketMessageSchema }) body: z.output<typeof ticketMessageSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { ticket, created } = await this.support.merchantReply(
      merchant.id,
      id,
      idempotencyKey,
      body.body,
      (files ?? []).map((file) => file.buffer),
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return ticket;
  }

  /** TK2: to the admin at any time, with a note. */
  @Post('merchant/shop/tickets/:id/escalate')
  @CustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantShopTicketSchema })
  @ApiOkResponse({ description: 'Sent to the admin', standardSchema: merchantShopTicketSchema })
  merchantEscalate(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @Body({ schema: shopTicketEscalationSchema }) body: z.output<typeof shopTicketEscalationSchema>,
    @Req() request: Request,
  ) {
    return this.support.escalateByMerchant(merchant.id, id, body.note, requestMeta(request));
  }

  @Get('merchant/shop/tickets/:id/attachments/:fileId')
  @CustomerRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'An image of the ticket' })
  async merchantAttachment(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(
      response,
      await this.support.merchantAttachment(merchant.id, id, fileId),
      'no-store',
    );
  }
}
