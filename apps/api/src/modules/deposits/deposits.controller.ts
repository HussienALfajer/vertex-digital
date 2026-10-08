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
  createShamCashDepositSchema,
  createUsdtDepositSchema,
  type DepositListQuery,
  depositListQuerySchema,
  depositPageSchema,
  depositSchema,
  shamCashOptionsSchema,
  submitReceiptSchema,
  submitTxidSchema,
  UPLOAD_MAX_BYTES,
  usdtOptionsSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { RequireAltcha } from '../../core/altcha/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { sendImage, uploadBody } from '../files/index.js';
import { DepositsService } from './deposits.service.js';

import { UsdtDepositsService } from './usdt-deposits.service.js';

/** One image, at most 5 MB (rule SC8); a larger one answers `413 PAYLOAD_TOO_LARGE`. */
const receiptUpload = FileInterceptor('file', {
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 4 },
});

/**
 * The customer's own deposits: Sham Cash (S03) and USDT (S04). Never cached (rules SC15, U18); a
 * deposit of another customer answers `404`. Creation, receipts and TXIDs have per-customer
 * limits in the database (SC6, U8).
 */
@ApiTags('deposits')
@Controller('deposits')
export class DepositsController {
  constructor(
    private readonly deposits: DepositsService,
    private readonly usdt: UsdtDepositsService,
  ) {}

  @Get('sham-cash/options')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: shamCashOptionsSchema })
  @ApiOkResponse({
    description: 'What the wizard offers now',
    standardSchema: shamCashOptionsSchema,
  })
  options(@CurrentCustomer() customer: CustomerIdentity) {
    return this.deposits.options(customer.id);
  }

  @Get('sham-cash/qr/:currency')
  @CustomerRoute()
  @ApiProduces('image/png')
  @ApiOkResponse({ description: 'The QR image of an enabled currency' })
  async qr(@Param('currency') currency: string, @Res({ passthrough: true }) response: Response) {
    return sendImage(response, await this.deposits.qr(currency), 'private, max-age=300');
  }

  @Post('sham-cash')
  @CustomerRoute()
  @RequireAltcha()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSchema })
  @ApiCreatedResponse({ description: 'Created (200: a replay)', standardSchema: depositSchema })
  async create(
    @CurrentCustomer() customer: CustomerIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createShamCashDepositSchema })
    body: z.output<typeof createShamCashDepositSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { deposit, created } = await this.deposits.create(
      customer.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return deposit;
  }

  @Get('usdt/options')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: usdtOptionsSchema })
  @ApiOkResponse({ description: 'The USDT networks now', standardSchema: usdtOptionsSchema })
  usdtOptions(@CurrentCustomer() customer: CustomerIdentity) {
    return this.usdt.options(customer.id);
  }

  @Post('usdt')
  @CustomerRoute()
  @RequireAltcha()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSchema })
  @ApiCreatedResponse({ description: 'Created (200: a replay)', standardSchema: depositSchema })
  async createUsdt(
    @CurrentCustomer() customer: CustomerIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: createUsdtDepositSchema }) body: z.output<typeof createUsdtDepositSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { deposit, created } = await this.usdt.create(
      customer.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return deposit;
  }

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(depositListQuerySchema)
  @SerializeOptions({ schema: depositPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: depositPageSchema })
  list(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: depositListQuerySchema }) query: DepositListQuery,
  ) {
    return this.deposits.list(customer.id, query);
  }

  @Get(':id')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSchema })
  @ApiOkResponse({ description: 'The deposit', standardSchema: depositSchema })
  read(@CurrentCustomer() customer: CustomerIdentity, @Param('id') id: string) {
    return this.deposits.read(customer.id, id);
  }

  @Post(':id/quote')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSchema })
  @ApiOkResponse({ description: 'A new 15-minute quote', standardSchema: depositSchema })
  requote(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.deposits.requote(customer.id, id, requestMeta(request));
  }

  @Post(':id/receipt')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @UseInterceptors(receiptUpload)
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody({ rateId: { type: 'string', format: 'uuid' } }))
  @SerializeOptions({ schema: depositSchema })
  @ApiOkResponse({ description: 'Submitted for review', standardSchema: depositSchema })
  submitReceipt(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body({ schema: submitReceiptSchema }) body: z.output<typeof submitReceiptSchema>,
    @Req() request: Request,
  ) {
    return this.deposits.submitReceipt(
      customer.id,
      id,
      file?.buffer,
      body.rateId,
      requestMeta(request),
    );
  }

  @Post(':id/txid')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSchema })
  @ApiOkResponse({ description: 'Verification started', standardSchema: depositSchema })
  submitTxid(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Body({ schema: submitTxidSchema }) body: z.output<typeof submitTxidSchema>,
    @Req() request: Request,
  ) {
    return this.usdt.submitTxid(customer.id, id, body, requestMeta(request));
  }

  @Post(':id/cancel')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSchema })
  @ApiOkResponse({ description: 'Cancelled', standardSchema: depositSchema })
  cancel(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id') id: string,
    @Req() request: Request,
  ) {
    return this.deposits.cancel(customer.id, id, requestMeta(request));
  }
}
