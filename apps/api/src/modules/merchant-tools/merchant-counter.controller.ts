import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  SerializeOptions,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  MERCHANT_LOGO_MAX_BYTES,
  orderSaleSchema,
  type RecentPlayersQuery,
  receiptSettingsSchema,
  recentPlayersQuerySchema,
  recentPlayersSchema,
  type SellingPriceInput,
  sellingPriceInputSchema,
  type UpdateReceiptSettings,
  updateReceiptSettingsSchema,
  uploadedLogoSchema,
} from '@vertex-digital/contracts';
import type { Response } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { sendImage, uploadBody } from '../files/index.js';
import { MerchantCounterService } from './merchant-counter.service.js';

/** BR3: one JPEG, PNG or WebP of at most 1 MB; a larger one answers `413 PAYLOAD_TOO_LARGE`. */
const logoUpload = FileInterceptor('file', {
  limits: { fileSize: MERCHANT_LOGO_MAX_BYTES, files: 1, fields: 2 },
});

/**
 * The counter tools (S21 F32, F34, F35): merchants only, never cached; a merchant reaches only their
 * own orders, ids, settings and logo.
 */
@ApiTags('merchant-tools')
@Controller()
export class MerchantCounterController {
  constructor(private readonly counter: MerchantCounterService) {}

  @Get('merchant/recent-players')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(recentPlayersQuerySchema)
  @SerializeOptions({ schema: recentPlayersSchema })
  @ApiOkResponse({
    description: 'The 20 newest distinct ids of the game (PS2)',
    standardSchema: recentPlayersSchema,
  })
  recentPlayers(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: recentPlayersQuerySchema }) query: RecentPlayersQuery,
  ) {
    return this.counter.recentPlayers(customer.id, query.gameId);
  }

  @Get('merchant/receipt-settings')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: receiptSettingsSchema })
  @ApiOkResponse({
    description: 'The receipt branding (BR3)',
    standardSchema: receiptSettingsSchema,
  })
  receiptSettings(@CurrentCustomer() customer: CustomerIdentity) {
    return this.counter.receiptSettings(customer.id);
  }

  @Put('merchant/receipt-settings')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: receiptSettingsSchema })
  @ApiOkResponse({ description: 'The saved branding', standardSchema: receiptSettingsSchema })
  saveReceiptSettings(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: updateReceiptSettingsSchema }) body: UpdateReceiptSettings,
  ) {
    return this.counter.saveReceiptSettings(customer.id, body);
  }

  @Post('merchant/logo')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @UseInterceptors(logoUpload)
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody())
  @SerializeOptions({ schema: uploadedLogoSchema })
  @ApiCreatedResponse({
    description: 'The stored logo, now the receipts’ logo (BR3)',
    standardSchema: uploadedLogoSchema,
  })
  uploadLogo(
    @CurrentCustomer() customer: CustomerIdentity,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.counter.uploadLogo(customer.id, file?.buffer);
  }

  @Get('merchant/logo/:fileId')
  @CustomerRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'The merchant’s own logo' })
  async logo(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(response, await this.counter.logo(customer.id, fileId), 'no-store');
  }

  /** SP5: the merchant's selling price of an own order; no money moves, no audit. */
  @Put('orders/:id/sale')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: orderSaleSchema })
  @ApiOkResponse({ description: 'The order’s sale', standardSchema: orderSaleSchema })
  setSale(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Body({ schema: sellingPriceInputSchema }) body: SellingPriceInput,
  ) {
    return this.counter.setSale(customer.id, id, body);
  }
}
