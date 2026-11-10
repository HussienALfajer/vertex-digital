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
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  createReturnRequestSchema,
  createShopCustomerSchema,
  merchantShopSchema,
  merchantShopStateSchema,
  requestShopSchema,
  returnRequestSchema,
  type ShopCustomerQuery,
  shopCustomerPageSchema,
  shopCustomerQuerySchema,
  shopCustomerRowSchema,
  shopHiddenGamesSchema,
  shopSettingsSchema,
  shopSlugSchema,
  shopTransferCheckResultSchema,
  shopTransferCheckSchema,
  shopTransferResultSchema,
  shopTransferSchema,
  slugAvailabilityQuerySchema,
  slugAvailabilitySchema,
  updateShopCustomerSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { ShopsMerchantService } from './shops-merchant.service.js';

/**
 * The merchant's shop under `/api/merchant/shop` (S26 "API"): the request and settings, hidden
 * games, the shop's customers, invitations, the transfer check, transfers and return requests.
 * Every route is the signed-in merchant's own (`NOT_MERCHANT` otherwise); money routes take an
 * `Idempotency-Key` and answer `201` when written, `200` on a replay.
 */
@ApiTags('shops')
@Controller('merchant/shop')
export class ShopsController {
  constructor(private readonly shops: ShopsMerchantService) {}

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @SerializeOptions({ schema: merchantShopStateSchema })
  @ApiOkResponse({
    description: 'The shop, or null before a request',
    standardSchema: merchantShopStateSchema,
  })
  async shop(@CurrentCustomer() merchant: CustomerIdentity) {
    return { shop: await this.shops.shopOf(merchant.id) };
  }

  @Get('slug-available')
  @CustomerRoute()
  @RateLimit({ limit: 60, perSeconds: 60 })
  @Header('cache-control', 'private, no-store')
  @ApiQueryOf(slugAvailabilityQuerySchema)
  @SerializeOptions({ schema: slugAvailabilitySchema })
  @ApiOkResponse({
    description: 'Whether the slug can be requested',
    standardSchema: slugAvailabilitySchema,
  })
  async slugAvailable(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Query({ schema: slugAvailabilityQuerySchema }) query: z.output<
      typeof slugAvailabilityQuerySchema
    >,
  ) {
    const slug = shopSlugSchema.safeParse(query.slug);
    if (!slug.success) return { available: false };
    return { available: await this.shops.slugAvailable(merchant.id, slug.data) };
  }

  @Post()
  @CustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: merchantShopSchema })
  @ApiCreatedResponse({
    description: 'Requested (200: a replay)',
    standardSchema: merchantShopSchema,
  })
  async request(
    @CurrentCustomer() merchant: CustomerIdentity,
    @IdempotencyKey() _key: string,
    @Body({ schema: requestShopSchema }) body: z.output<typeof requestShopSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { shop, replayed } = await this.shops.request(merchant.id, body, requestMeta(request));
    response.status(replayed ? 200 : 201);
    return shop;
  }

  @Patch()
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @SerializeOptions({ schema: merchantShopSchema })
  @ApiOkResponse({ description: 'The settings saved', standardSchema: merchantShopSchema })
  update(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Body({ schema: shopSettingsSchema }) body: z.output<typeof shopSettingsSchema>,
    @Req() request: Request,
  ) {
    return this.shops.updateSettings(merchant.id, body, requestMeta(request));
  }

  @Get('hidden-games')
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @SerializeOptions({ schema: shopHiddenGamesSchema })
  @ApiOkResponse({ description: 'The hidden games', standardSchema: shopHiddenGamesSchema })
  hiddenGames(@CurrentCustomer() merchant: CustomerIdentity) {
    return this.shops.hiddenGames(merchant.id);
  }

  @Put('hidden-games')
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @SerializeOptions({ schema: shopHiddenGamesSchema })
  @ApiOkResponse({ description: 'The hidden games saved', standardSchema: shopHiddenGamesSchema })
  setHiddenGames(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Body({ schema: shopHiddenGamesSchema }) body: z.output<typeof shopHiddenGamesSchema>,
    @Req() request: Request,
  ) {
    return this.shops.setHiddenGames(merchant.id, body.gameIds, requestMeta(request));
  }

  @Get('customers')
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @ApiQueryOf(shopCustomerQuerySchema)
  @SerializeOptions({ schema: shopCustomerPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: shopCustomerPageSchema })
  customers(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Query({ schema: shopCustomerQuerySchema }) query: ShopCustomerQuery,
  ) {
    return this.shops.customers(merchant.id, query);
  }

  @Post('customers')
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: shopCustomerRowSchema })
  @ApiCreatedResponse({ description: 'Created and invited', standardSchema: shopCustomerRowSchema })
  createCustomer(
    @CurrentCustomer() merchant: CustomerIdentity,
    @IdempotencyKey() _key: string,
    @Body({ schema: createShopCustomerSchema }) body: z.output<typeof createShopCustomerSchema>,
    @Req() request: Request,
  ) {
    return this.shops.createCustomer(merchant.id, body, requestMeta(request));
  }

  @Patch('customers/:id')
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @SerializeOptions({ schema: shopCustomerRowSchema })
  @ApiOkResponse({ description: 'Saved', standardSchema: shopCustomerRowSchema })
  updateCustomer(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @Body({ schema: updateShopCustomerSchema }) body: z.output<typeof updateShopCustomerSchema>,
    @Req() request: Request,
  ) {
    return this.shops.updateCustomer(merchant.id, id, body, requestMeta(request));
  }

  @Post('customers/:id/invite')
  @CustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(204)
  @ApiOkResponse({ description: 'A new invitation was sent' })
  async invite(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    await this.shops.reinvite(merchant.id, id, requestMeta(request));
  }

  @Post('transfer-check')
  @CustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @HttpCode(200)
  @Header('cache-control', 'private, no-store')
  @SerializeOptions({ schema: shopTransferCheckResultSchema })
  @ApiOkResponse({
    description: 'Transfers open until',
    standardSchema: shopTransferCheckResultSchema,
  })
  async transferCheck(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Body({ schema: shopTransferCheckSchema }) body: z.output<typeof shopTransferCheckSchema>,
  ) {
    const until = await this.shops.confirmForTransfers(merchant, body.password);
    return { checkedUntil: until.toISOString() };
  }

  @Post('customers/:id/transfers')
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @ApiIdempotencyKey()
  @Header('cache-control', 'private, no-store')
  @SerializeOptions({ schema: shopTransferResultSchema })
  @ApiCreatedResponse({
    description: 'Transferred (200: a replay)',
    standardSchema: shopTransferResultSchema,
  })
  async transfer(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: shopTransferSchema }) body: z.output<typeof shopTransferSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { result, replayed } = await this.shops.transfer(
      merchant,
      id,
      body,
      idempotencyKey,
      requestMeta(request),
    );
    response.status(replayed ? 200 : 201);
    return result;
  }

  @Post('customers/:id/return-requests')
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @ApiIdempotencyKey()
  @SerializeOptions({ schema: returnRequestSchema })
  @ApiCreatedResponse({
    description: 'Requested (200: a replay)',
    standardSchema: returnRequestSchema,
  })
  async requestReturn(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createReturnRequestSchema }) body: z.output<typeof createReturnRequestSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { request: created, replayed } = await this.shops.requestReturn(
      merchant.id,
      id,
      body.amountUsdUnits,
      idempotencyKey,
      requestMeta(request),
    );
    response.status(replayed ? 200 : 201);
    return created;
  }

  @Delete('customers/:id/return-requests/:requestId')
  @CustomerRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @SerializeOptions({ schema: returnRequestSchema })
  @ApiOkResponse({ description: 'Cancelled', standardSchema: returnRequestSchema })
  cancelReturn(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Req() request: Request,
  ) {
    return this.shops.cancelReturn(merchant.id, id, requestId, requestMeta(request));
  }
}
