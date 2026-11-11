import {
  Controller,
  Get,
  Header,
  Query,
  Res,
  SerializeOptions,
  StreamableFile,
} from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type MerchantShopOrderQuery,
  merchantShopOrderPageSchema,
  merchantShopOrderQuerySchema,
  type ShopStatsQuery,
  shopStatsQuerySchema,
  shopStatsSchema,
  shopStickerQuerySchema,
} from '@vertex-digital/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import type { CustomerIdentity } from '../auth/index.js';
import { ShopSellingService } from './shop-selling.service.js';

/**
 * The merchant's view of the shop's selling (S26 PR9, SP2, SP3): "طلبات المتجر" with each order's
 * margin, the statistics and the printable sticker. The merchant reads them in any shop state but
 * rejected; a frozen merchant reads too.
 */
@ApiTags('shops')
@Controller('merchant/shop')
export class ShopMerchantSalesController {
  constructor(private readonly selling: ShopSellingService) {}

  @Get('orders')
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @ApiQueryOf(merchantShopOrderQuerySchema)
  @SerializeOptions({ schema: merchantShopOrderPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: merchantShopOrderPageSchema })
  orders(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Query({ schema: merchantShopOrderQuerySchema }) query: MerchantShopOrderQuery,
  ) {
    return this.selling.merchantOrders(merchant.id, query);
  }

  @Get('stats')
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @ApiQueryOf(shopStatsQuerySchema)
  @SerializeOptions({ schema: shopStatsSchema })
  @ApiOkResponse({ description: 'By Damascus day (SP3)', standardSchema: shopStatsSchema })
  stats(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Query({ schema: shopStatsQuerySchema }) query: ShopStatsQuery,
  ) {
    return this.selling.stats(merchant.id, query);
  }

  @Get('sticker.png')
  @CustomerRoute()
  @ApiProduces('image/png')
  @ApiQueryOf(shopStickerQuerySchema)
  @ApiOkResponse({ description: 'The printable sticker (SP2)' })
  async sticker(
    @CurrentCustomer() merchant: CustomerIdentity,
    @Query({ schema: shopStickerQuerySchema }) query: z.output<typeof shopStickerQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const png = await this.selling.sticker(merchant.id, query.size);
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('content-type', 'image/png');
    response.setHeader('content-disposition', `attachment; filename="sticker-${query.size}.png"`);
    response.setHeader('x-content-type-options', 'nosniff');
    return new StreamableFile(png);
  }
}
