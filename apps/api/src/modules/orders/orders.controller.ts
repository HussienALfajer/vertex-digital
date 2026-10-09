import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  checkoutRequestSchema,
  checkoutSchema,
  createdOrderSchema,
  createOrderSchema,
  type OrderListQuery,
  orderListQuerySchema,
  orderPageSchema,
  orderSchema,
  type PlayerCheckRequest,
  playerCheckRequestSchema,
  playerCheckSchema,
  type ReceiptOptions,
  receiptOptionsSchema,
  revealedCodeSchema,
  type SavedPlayerListQuery,
  savedPlayerListQuerySchema,
  savedPlayerListSchema,
  savedPlayerSchema,
  shareLinkSchema,
  type UpdateSavedPlayer,
  updateSavedPlayerSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { CustomerIdentity } from '../auth/index.js';
import { type CheckoutBody, OrdersService, type PurchaseBody } from './orders.service.js';
import { PlayerChecksService } from './player-checks.service.js';
import { SavedPlayersService } from './saved-players.service.js';
import { ShareLinksService } from './share-links.service.js';

/**
 * The customer's orders (S08): no customer id in the routes, another customer's order answers
 * `404`, never cached. A purchase takes an `Idempotency-Key`: `201` when written, `200` replayed.
 */
@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly playerChecks: PlayerChecksService,
    private readonly savedPlayers: SavedPlayersService,
    private readonly shareLinks: ShareLinksService,
  ) {}

  /** S09 rules PV1–PV7: limited per customer and address for the calls that reach a supplier. */
  @Post('player-checks')
  @CustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: playerCheckSchema })
  @ApiOkResponse({
    description: 'The check, from the cache or a supplier',
    standardSchema: playerCheckSchema,
  })
  checkPlayer(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: playerCheckRequestSchema }) body: PlayerCheckRequest,
    @Req() request: Request,
  ) {
    return this.playerChecks.check(customer.id, body, requestMeta(request));
  }

  @Post('orders')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: createdOrderSchema })
  @ApiCreatedResponse({
    description:
      'Paid, or reserved with `whenBalanceShort: reserve` (200: a replay); `savedPlayer` (S10 SP1)',
    standardSchema: createdOrderSchema,
  })
  async purchase(
    @CurrentCustomer() customer: CustomerIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createOrderSchema }) body: PurchaseBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { order, created } = await this.orders.purchase(
      customer.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return order;
  }

  /** S10 rules CT5, CT9: a cart, all or nothing; one purchase in the limits. */
  @Post('checkouts')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: checkoutSchema })
  @ApiCreatedResponse({
    description: 'Every line paid, one order each (200: a replay)',
    standardSchema: checkoutSchema,
  })
  async checkout(
    @CurrentCustomer() customer: CustomerIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: checkoutRequestSchema }) body: CheckoutBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { checkout, created } = await this.orders.checkout(
      customer.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return checkout;
  }

  /** S10 rules SP3, SP5: the customer's saved ids, newest used first. */
  @Get('saved-players')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(savedPlayerListQuerySchema)
  @SerializeOptions({ schema: savedPlayerListSchema })
  @ApiOkResponse({ description: 'At most 50, no paging', standardSchema: savedPlayerListSchema })
  savedPlayerList(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: savedPlayerListQuerySchema }) query: SavedPlayerListQuery,
  ) {
    return this.savedPlayers.list(customer.id, query);
  }

  @Patch('saved-players/:id')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: savedPlayerSchema })
  @ApiOkResponse({ description: 'The renamed id', standardSchema: savedPlayerSchema })
  renameSavedPlayer(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Body({ schema: updateSavedPlayerSchema }) body: UpdateSavedPlayer,
  ) {
    return this.savedPlayers.rename(customer.id, id, body.label);
  }

  @Delete('saved-players/:id')
  @CustomerRoute()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'Deleted for good' })
  async deleteSavedPlayer(@CurrentCustomer() customer: CustomerIdentity, @Param('id') id: string) {
    await this.savedPlayers.remove(customer.id, id);
  }

  @Get('orders')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(orderListQuerySchema)
  @SerializeOptions({ schema: orderPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: orderPageSchema })
  list(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: orderListQuerySchema }) query: OrderListQuery,
  ) {
    return this.orders.list(customer.id, query);
  }

  @Get('orders/:id')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: orderSchema })
  @ApiOkResponse({ description: 'The order, codes masked', standardSchema: orderSchema })
  order(@CurrentCustomer() customer: CustomerIdentity, @Param('id') id: string) {
    return this.orders.order(customer.id, id);
  }

  /** S09 rule RS8: a reservation only; any other status is `ORDER_NOT_CANCELLABLE`. */
  @Post('orders/:id/cancel')
  @CustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: orderSchema })
  @ApiOkResponse({ description: 'The cancelled reservation', standardSchema: orderSchema })
  cancel(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.orders.cancel(customer.id, id, requestMeta(request));
  }

  /** S10 rule RC1: creates the receipt link, or changes the live one's choices. */
  @Put('orders/:id/receipt-link')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: shareLinkSchema })
  @ApiOkResponse({ description: 'The live receipt link', standardSchema: shareLinkSchema })
  receiptLink(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Body({ schema: receiptOptionsSchema }) body: Required<ReceiptOptions>,
  ) {
    return this.shareLinks.receiptLink(customer.id, id, body);
  }

  /** S10 rule GF4: a new gift link after a revocation. */
  @Post('orders/:id/gift-link')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: shareLinkSchema })
  @ApiCreatedResponse({ description: 'The new gift link', standardSchema: shareLinkSchema })
  giftLink(@CurrentCustomer() customer: CustomerIdentity, @Param('id') id: string) {
    return this.shareLinks.giftLink(customer.id, id);
  }

  /** S10 rule RC3: final; a revoked link answers `204` again. */
  @Post('orders/:id/share-links/:linkId/revoke')
  @CustomerRoute()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'The link answers not found from now on' })
  async revokeShareLink(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
  ) {
    await this.shareLinks.revoke(customer.id, id, linkId);
  }

  @Post('orders/:id/codes/:codeId/reveal')
  @CustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: revealedCodeSchema })
  @ApiOkResponse({
    description: 'The code; the reveal is logged',
    standardSchema: revealedCodeSchema,
  })
  reveal(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Param('codeId') codeId: string,
    @Req() request: Request,
  ) {
    return this.orders.reveal(customer.id, id, codeId, requestMeta(request));
  }
}
