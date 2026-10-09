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
  revealedCodeSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { CustomerIdentity } from '../auth/index.js';
import { OrdersService, type PurchaseBody } from './orders.service.js';

/**
 * The customer's orders (S08): no customer id in the routes, another customer's order answers
 * `404`, never cached. A purchase takes an `Idempotency-Key`: `201` when written, `200` replayed.
 */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: orderSchema })
  @ApiCreatedResponse({ description: 'Paid (200: a replay)', standardSchema: orderSchema })
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

  @Get()
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

  @Get(':id')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: orderSchema })
  @ApiOkResponse({ description: 'The order, codes masked', standardSchema: orderSchema })
  order(@CurrentCustomer() customer: CustomerIdentity, @Param('id') id: string) {
    return this.orders.order(customer.id, id);
  }

  @Post(':id/codes/:codeId/reveal')
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
