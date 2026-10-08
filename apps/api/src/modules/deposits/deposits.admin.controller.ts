import {
  Body,
  Controller,
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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  type AdminDepositQuery,
  type AdminUsdtTransferQuery,
  adminDepositCountsSchema,
  adminDepositPageSchema,
  adminDepositQuerySchema,
  adminDepositSchema,
  adminUsdtTransferPageSchema,
  adminUsdtTransferQuerySchema,
  approveDepositSchema,
  approveUsdtDepositSchema,
  depositSettingsInputSchema,
  depositSettingsSchema,
  rejectDepositSchema,
  requestReceiptSchema,
  storedFileRefSchema,
  UPLOAD_MAX_BYTES,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { CodedException } from '../../core/errors/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { FilesService } from '../files/index.js';
import { isUuid } from './deposit-records.js';
import { DepositReviewService } from './deposit-review.service.js';
import { DepositSettingsService } from './deposit-settings.service.js';
import { sendImage, uploadBody } from './served-file.js';
import { UsdtReviewService } from './usdt-review.service.js';

const qrUpload = FileInterceptor('file', {
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 0 },
});

/**
 * The admin's side of deposits (S03, S04): the settings, the review queue, the decisions and the
 * USDT transfers. Saving settings, uploading a QR and approving a USDT deposit need a
 * re-authentication; a Sham Cash approval needs one above $100 or with any flag (rule RV4),
 * checked by the service. Decisions carry an `Idempotency-Key`.
 */
@ApiTags('deposits')
@Controller('admin')
export class DepositsAdminController {
  constructor(
    private readonly review: DepositReviewService,
    private readonly settings: DepositSettingsService,
    private readonly files: FilesService,
    private readonly usdt: UsdtReviewService,
  ) {}

  @Get('deposit-settings')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSettingsSchema })
  @ApiOkResponse({
    description: 'In force, or the defaults',
    standardSchema: depositSettingsSchema,
  })
  readSettings() {
    return this.settings.read();
  }

  @Put('deposit-settings')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: depositSettingsSchema })
  @ApiOkResponse({ description: 'The new version', standardSchema: depositSettingsSchema })
  saveSettings(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: depositSettingsInputSchema })
    body: z.output<typeof depositSettingsInputSchema>,
    @Req() request: Request,
  ) {
    return this.settings.save(admin.id, body, requestMeta(request));
  }

  @Post('deposit-settings/qr')
  @AdminRoute()
  @Sensitive()
  @UseInterceptors(qrUpload)
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody())
  @SerializeOptions({ schema: storedFileRefSchema })
  @ApiOkResponse({ description: 'The re-encoded PNG', standardSchema: storedFileRefSchema })
  uploadQr(@UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.settings.uploadQr(file?.buffer);
  }

  @Get('deposit-settings/qr/:fileId')
  @AdminRoute()
  @ApiProduces('image/png')
  @ApiOkResponse({ description: 'A QR image' })
  async qr(@Param('fileId') fileId: string, @Res({ passthrough: true }) response: Response) {
    const file = isUuid(fileId) ? await this.files.serve(fileId, 'sham_cash_qr') : null;
    if (!file) throw new CodedException(404, 'NOT_FOUND', 'No such QR image');
    return sendImage(response, file, 'private, no-store');
  }

  @Get('deposits')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(adminDepositQuerySchema)
  @SerializeOptions({ schema: adminDepositPageSchema })
  @ApiOkResponse({ description: 'Rule RV10 order', standardSchema: adminDepositPageSchema })
  queue(@Query({ schema: adminDepositQuerySchema }) query: AdminDepositQuery) {
    return this.review.queue(query);
  }

  // Before `deposits/:id`, so `counts` is not read as an id.
  @Get('deposits/counts')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminDepositCountsSchema })
  @ApiOkResponse({ description: 'The navigation badge', standardSchema: adminDepositCountsSchema })
  counts() {
    return this.review.counts();
  }

  @Get('deposits/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminDepositSchema })
  @ApiOkResponse({ description: 'The deposit and its review', standardSchema: adminDepositSchema })
  deposit(@Param('id') id: string) {
    return this.review.deposit(id);
  }

  @Get('deposits/:id/receipts/:receiptId')
  @AdminRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'The re-encoded receipt' })
  async receipt(
    @Param('id') id: string,
    @Param('receiptId') receiptId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(response, await this.review.receipt(id, receiptId), 'private, no-store');
  }

  @Post('deposits/:id/approve')
  @AdminRoute()
  @ApiIdempotencyKey()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminDepositSchema })
  @ApiOkResponse({ description: 'Credited (or its replay)', standardSchema: adminDepositSchema })
  async approve(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: approveDepositSchema }) body: z.output<typeof approveDepositSchema>,
    @Req() request: Request,
  ) {
    const { deposit } = await this.review.approve(
      admin,
      id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    return deposit;
  }

  @Post('deposits/:id/reject')
  @AdminRoute()
  @ApiIdempotencyKey()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminDepositSchema })
  @ApiOkResponse({ description: 'Rejected (or its replay)', standardSchema: adminDepositSchema })
  async reject(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: rejectDepositSchema }) body: z.output<typeof rejectDepositSchema>,
    @Req() request: Request,
  ) {
    const { deposit } = await this.review.reject(
      admin.id,
      id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    return deposit;
  }

  @Post('deposits/:id/request-receipt')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminDepositSchema })
  @ApiOkResponse({ description: 'Back to pending', standardSchema: adminDepositSchema })
  requestReceipt(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: requestReceiptSchema }) body: z.output<typeof requestReceiptSchema>,
    @Req() request: Request,
  ) {
    return this.review.requestReceipt(admin.id, id, body, requestMeta(request));
  }

  @Post('deposits/:id/approve-usdt')
  @AdminRoute()
  @Sensitive()
  @ApiIdempotencyKey()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminDepositSchema })
  @ApiOkResponse({ description: 'Credited (or its replay)', standardSchema: adminDepositSchema })
  async approveUsdt(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: approveUsdtDepositSchema }) body: z.output<typeof approveUsdtDepositSchema>,
    @Req() request: Request,
  ) {
    const { deposit } = await this.usdt.approve(
      admin,
      id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    return deposit;
  }

  @Post('deposits/:id/recheck')
  @AdminRoute()
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminDepositSchema })
  @ApiAcceptedResponse({
    description: 'Verification sent again',
    standardSchema: adminDepositSchema,
  })
  recheck(@CurrentAdmin() admin: AdminIdentity, @Param('id') id: string, @Req() request: Request) {
    return this.usdt.recheck(admin.id, id, requestMeta(request));
  }

  @Get('usdt-transfers')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(adminUsdtTransferQuerySchema)
  @SerializeOptions({ schema: adminUsdtTransferPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: adminUsdtTransferPageSchema })
  transfers(@Query({ schema: adminUsdtTransferQuerySchema }) query: AdminUsdtTransferQuery) {
    return this.usdt.transfers(query);
  }
}
