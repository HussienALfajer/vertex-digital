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
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  createOrderSchema,
  type OrderListQuery,
  orderListQuerySchema,
  orderPageSchema,
  orderSchema,
  type PlayerCheckRequest,
  playerCheckRequestSchema,
  playerCheckSchema,
  revealedCodeSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { CustomerIdentity } from '../auth/index.js';
import { OrdersService, type PurchaseBody } from './orders.service.js';
import { PlayerChecksService } from './player-checks.service.js';

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
  @SerializeOptions({ schema: orderSchema })
  @ApiCreatedResponse({
    description: 'Paid, or reserved with `whenBalanceShort: reserve` (200: a replay)',
    standardSchema: orderSchema,
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
