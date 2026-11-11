import {
  Body,
  Controller,
  Delete,
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
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type MarkNotificationsRead,
  markNotificationsReadSchema,
  type NotificationListQuery,
  notificationListQuerySchema,
  type PlayerCheckRequest,
  type PushSubscription,
  playerCheckRequestSchema,
  playerCheckSchema,
  pushSubscriptionSchema,
  type RemovePushSubscription,
  removePushSubscriptionSchema,
  revealedCodeSchema,
  type ShopOrderListQuery,
  shopNotificationPageSchema,
  shopOrderListQuerySchema,
  shopOrderPageSchema,
  shopOrderSchema,
  shopPurchaseSchema,
  unreadCountSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentShopCustomer, ShopCustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { ShopCustomerIdentity } from './shop-auth.service.js';
import { ShopNotificationsService } from './shop-notifications.service.js';
import { ShopSellingService } from './shop-selling.service.js';

/**
 * The signed-in shop customer's purchases and notifications under `/api/shops/:slug/` (S26
 * PR5–PR12, PR9, SP1): the purchase, the customer's own orders and codes at the selling price,
 * the player check, the notification center and this device's push subscription. A session of
 * another shop, a Vertex session or none is `401`; another customer's order is `404`.
 */
@ApiTags('shops')
@Controller('shops/:slug')
export class ShopOrdersController {
  constructor(
    private readonly selling: ShopSellingService,
    private readonly notifications: ShopNotificationsService,
  ) {}

  @Post('orders')
  @ShopCustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: shopOrderSchema })
  @ApiCreatedResponse({
    description: 'Paid from the shop wallet (200: a replay)',
    standardSchema: shopOrderSchema,
  })
  async purchase(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Body({ schema: shopPurchaseSchema }) body: z.output<typeof shopPurchaseSchema>,
    @IdempotencyKey() idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { order, created } = await this.selling.purchase(
      customer,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return order;
  }

  @Get('orders')
  @ShopCustomerRoute()
  @ApiQueryOf(shopOrderListQuerySchema)
  @SerializeOptions({ schema: shopOrderPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: shopOrderPageSchema })
  orders(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Query({ schema: shopOrderListQuerySchema }) query: ShopOrderListQuery,
  ) {
    return this.selling.orders(customer, query);
  }

  @Get('orders/:number')
  @ShopCustomerRoute()
  @SerializeOptions({ schema: shopOrderSchema })
  @ApiOkResponse({ description: 'The order at its selling price', standardSchema: shopOrderSchema })
  order(@CurrentShopCustomer() customer: ShopCustomerIdentity, @Param('number') number: string) {
    return this.selling.order(customer, number);
  }

  /** PR12, rule C2. */
  @Post('orders/:number/codes/:codeId/reveal')
  @ShopCustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: revealedCodeSchema })
  @ApiOkResponse({ description: 'The code, its reveal logged', standardSchema: revealedCodeSchema })
  reveal(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Param('number') number: string,
    @Param('codeId') codeId: string,
    @Req() request: Request,
  ) {
    return this.selling.reveal(customer, number, codeId, requestMeta(request));
  }

  @Post('player-checks')
  @ShopCustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @HttpCode(200)
  @SerializeOptions({ schema: playerCheckSchema })
  @ApiOkResponse({ description: 'The player check (PR5)', standardSchema: playerCheckSchema })
  playerCheck(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Body({ schema: playerCheckRequestSchema }) body: PlayerCheckRequest,
    @Req() request: Request,
  ) {
    return this.selling.playerCheck(customer, body, requestMeta(request));
  }

  @Get('notifications')
  @ShopCustomerRoute()
  @ApiQueryOf(notificationListQuerySchema)
  @SerializeOptions({ schema: shopNotificationPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: shopNotificationPageSchema })
  notificationList(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Query({ schema: notificationListQuerySchema }) query: NotificationListQuery,
  ) {
    return this.notifications.list(customer, query);
  }

  @Get('notifications/unread-count')
  @ShopCustomerRoute()
  @SerializeOptions({ schema: unreadCountSchema })
  @ApiOkResponse({ description: 'The unread count', standardSchema: unreadCountSchema })
  unread(@CurrentShopCustomer() customer: ShopCustomerIdentity) {
    return this.notifications.unread(customer);
  }

  @Post('notifications/read')
  @ShopCustomerRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: unreadCountSchema })
  @ApiOkResponse({ description: 'Read up to this one', standardSchema: unreadCountSchema })
  markRead(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Body({ schema: markNotificationsReadSchema }) body: MarkNotificationsRead,
  ) {
    return this.notifications.markRead(customer, body.upToId);
  }

  @Put('push-subscription')
  @ShopCustomerRoute()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'This device receives the shop’s pushes' })
  async register(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Body({ schema: pushSubscriptionSchema }) body: PushSubscription,
  ) {
    await this.notifications.register(customer, body);
  }

  @Delete('push-subscription')
  @ShopCustomerRoute()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'This device no longer receives the shop’s pushes' })
  async remove(
    @CurrentShopCustomer() customer: ShopCustomerIdentity,
    @Body({ schema: removePushSubscriptionSchema }) body: RemovePushSubscription,
  ) {
    await this.notifications.remove(customer, body.endpoint);
  }
}
