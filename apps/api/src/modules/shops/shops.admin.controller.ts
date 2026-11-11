import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type AdminShopQuery,
  adminShopCustomerPageSchema,
  adminShopPageSchema,
  adminShopQuerySchema,
  adminShopSchema,
  approveShopSchema,
  type MerchantShopOrderQuery,
  merchantShopOrderPageSchema,
  merchantShopOrderQuerySchema,
  type ShopCustomerQuery,
  settleShopCustomerSchema,
  shopCompensationRequestSchema,
  shopCompensationSchema,
  shopCustomerQuerySchema,
  shopReasonSchema,
  shopSettlementSchema,
  suspendShopSchema,
  updateShopSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { ShopSellingService } from './shop-selling.service.js';
import { ShopsAdminService } from './shops-admin.service.js';

/**
 * The admin's shops (S26 "API"): the list and a shop, the review and the states, the limits and
 * slug, the settlement of a closed shop, and a shop customer's freeze. Closing, the limits and the
 * settlement need a recent re-authentication (S26 Access).
 */
@ApiTags('shops')
@Controller('admin')
export class ShopsAdminController {
  constructor(
    private readonly shops: ShopsAdminService,
    private readonly selling: ShopSellingService,
  ) {}

  /** PR10: Vertex's part, and the margin from the merchant, the store or nobody. */
  @Post('orders/:id/shop-compensation')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: shopCompensationSchema })
  @ApiCreatedResponse({
    description: 'Compensated (200: a replay)',
    standardSchema: shopCompensationSchema,
  })
  async compensate(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: shopCompensationRequestSchema })
    body: z.output<typeof shopCompensationRequestSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { compensation, replayed } = await this.selling.compensate(
      id,
      body,
      idempotencyKey,
      admin.id,
      requestMeta(request),
    );
    response.status(replayed ? 200 : 201);
    return compensation;
  }

  @Get('shops')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(adminShopQuerySchema)
  @SerializeOptions({ schema: adminShopPageSchema })
  @ApiOkResponse({ description: 'Newest request first', standardSchema: adminShopPageSchema })
  list(@Query({ schema: adminShopQuerySchema }) query: AdminShopQuery) {
    return this.shops.list(query);
  }

  @Get('shops/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminShopSchema })
  @ApiOkResponse({ description: 'The shop', standardSchema: adminShopSchema })
  shop(@Param('id') id: string) {
    return this.shops.shop(id);
  }

  @Get('shops/:id/customers')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(shopCustomerQuerySchema)
  @SerializeOptions({ schema: adminShopCustomerPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: adminShopCustomerPageSchema })
  customers(
    @Param('id') id: string,
    @Query({ schema: shopCustomerQuerySchema }) query: ShopCustomerQuery,
  ) {
    return this.shops.customers(id, query);
  }

  @Get('shops/:id/orders')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(merchantShopOrderQuerySchema)
  @SerializeOptions({ schema: merchantShopOrderPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: merchantShopOrderPageSchema })
  orders(
    @Param('id') id: string,
    @Query({ schema: merchantShopOrderQuerySchema }) query: MerchantShopOrderQuery,
  ) {
    return this.selling.adminOrders(id, query);
  }

  @Post('shops/:id/approve')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: adminShopSchema })
  @ApiOkResponse({ description: 'Approved', standardSchema: adminShopSchema })
  approve(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: approveShopSchema }) body: z.output<typeof approveShopSchema>,
    @Req() request: Request,
  ) {
    return this.shops.approve(admin, id, body, requestMeta(request));
  }

  @Post('shops/:id/reject')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: adminShopSchema })
  @ApiOkResponse({ description: 'Rejected', standardSchema: adminShopSchema })
  reject(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: shopReasonSchema }) body: z.output<typeof shopReasonSchema>,
    @Req() request: Request,
  ) {
    return this.shops.reject(admin, id, body.reason, requestMeta(request));
  }

  @Post('shops/:id/suspend')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: adminShopSchema })
  @ApiOkResponse({ description: 'Suspended', standardSchema: adminShopSchema })
  suspend(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: suspendShopSchema }) body: z.output<typeof suspendShopSchema>,
    @Req() request: Request,
  ) {
    return this.shops.suspend(admin, id, body, requestMeta(request));
  }

  @Post('shops/:id/resume')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: adminShopSchema })
  @ApiOkResponse({ description: 'Resumed', standardSchema: adminShopSchema })
  resume(@CurrentAdmin() admin: AdminIdentity, @Param('id') id: string, @Req() request: Request) {
    return this.shops.resume(admin, id, requestMeta(request));
  }

  @Post('shops/:id/close')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminShopSchema })
  @ApiOkResponse({ description: 'Closed', standardSchema: adminShopSchema })
  close(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: shopReasonSchema }) body: z.output<typeof shopReasonSchema>,
    @Req() request: Request,
  ) {
    return this.shops.close(admin, id, body.reason, requestMeta(request));
  }

  @Patch('shops/:id')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: adminShopSchema })
  @ApiOkResponse({ description: 'Saved', standardSchema: adminShopSchema })
  update(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: updateShopSchema }) body: z.output<typeof updateShopSchema>,
    @Req() request: Request,
  ) {
    return this.shops.update(admin, id, body, requestMeta(request));
  }

  @Post('shops/:id/customers/:customerId/settle')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: shopSettlementSchema })
  @ApiCreatedResponse({
    description: 'Settled (200: a replay)',
    standardSchema: shopSettlementSchema,
  })
  async settle(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Param('customerId') customerId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: settleShopCustomerSchema }) body: z.output<typeof settleShopCustomerSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { settlement, replayed } = await this.shops.settle(
      admin,
      id,
      customerId,
      body,
      idempotencyKey,
      requestMeta(request),
    );
    response.status(replayed ? 200 : 201);
    return settlement;
  }

  @Post('shop-customers/:id/freeze')
  @AdminRoute()
  @HttpCode(204)
  @ApiOkResponse({ description: 'Frozen' })
  async freeze(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: shopReasonSchema }) body: z.output<typeof shopReasonSchema>,
    @Req() request: Request,
  ) {
    await this.shops.setFrozen(admin, id, true, body.reason, requestMeta(request));
  }

  @Post('shop-customers/:id/unfreeze')
  @AdminRoute()
  @HttpCode(204)
  @ApiOkResponse({ description: 'Unfrozen' })
  async unfreeze(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: shopReasonSchema }) body: z.output<typeof shopReasonSchema>,
    @Req() request: Request,
  ) {
    await this.shops.setFrozen(admin, id, false, body.reason, requestMeta(request));
  }
}
