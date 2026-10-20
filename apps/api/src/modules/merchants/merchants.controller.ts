import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  type AcceptMerchantTerms,
  acceptMerchantTermsSchema,
  type MerchantApplicationValues,
  merchantApplicationInputSchema,
  merchantApplicationSchema,
  merchantApplicationStateSchema,
  merchantPhotoSchema,
  UPLOAD_MAX_BYTES,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiIdempotencyKey, IdempotencyKey } from '../../core/http/idempotency-key.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { sendImage, uploadBody } from '../files/index.js';
import { MerchantsService } from './merchants.service.js';

/** MA3: one JPEG, PNG or WebP of at most 5 MB; a larger one answers `413 PAYLOAD_TOO_LARGE`. */
const photoUpload = FileInterceptor('file', {
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 2 },
});

/**
 * The customer's merchant application and terms (S20 F28). Never cached; a customer reaches only
 * their own application and photos.
 */
@ApiTags('merchants')
@Controller('merchant')
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Get('application')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantApplicationStateSchema })
  @ApiOkResponse({
    description: 'The latest application and whether one may be submitted (MA1)',
    standardSchema: merchantApplicationStateSchema,
  })
  state(@CurrentCustomer() customer: CustomerIdentity) {
    return this.merchants.state(customer.id);
  }

  @Post('application')
  @CustomerRoute()
  @RateLimit({ limit: 10, perSeconds: 60 })
  @ApiIdempotencyKey()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantApplicationSchema })
  @ApiCreatedResponse({
    description: 'Submitted (200: a replay)',
    standardSchema: merchantApplicationSchema,
  })
  async submit(
    @CurrentCustomer() customer: CustomerIdentity,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: merchantApplicationInputSchema }) body: MerchantApplicationValues,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { application, created } = await this.merchants.submit(
      customer.id,
      idempotencyKey,
      body,
      requestMeta(request),
    );
    response.status(created ? 201 : 200);
    return application;
  }

  @Put('application')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantApplicationSchema })
  @ApiOkResponse({ description: 'Resubmitted (MA4)', standardSchema: merchantApplicationSchema })
  resubmit(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: merchantApplicationInputSchema }) body: MerchantApplicationValues,
    @Req() request: Request,
  ) {
    return this.merchants.resubmit(customer.id, body, requestMeta(request));
  }

  @Post('application/withdraw')
  @CustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantApplicationSchema })
  @ApiOkResponse({ description: 'Withdrawn (MA4)', standardSchema: merchantApplicationSchema })
  withdraw(@CurrentCustomer() customer: CustomerIdentity, @Req() request: Request) {
    return this.merchants.withdraw(customer.id, requestMeta(request));
  }

  @Post('application/photo')
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @UseInterceptors(photoUpload)
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody())
  @SerializeOptions({ schema: merchantPhotoSchema })
  @ApiCreatedResponse({
    description: 'The stored photo (MA3)',
    standardSchema: merchantPhotoSchema,
  })
  photoUpload(
    @CurrentCustomer() customer: CustomerIdentity,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.merchants.uploadPhoto(customer.id, file?.buffer);
  }

  @Get('application/photo/:fileId')
  @CustomerRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'A shop photo of this customer (MA3)' })
  async photo(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(response, await this.merchants.photo(customer.id, fileId), 'no-store');
  }

  @Post('terms')
  @CustomerRoute()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'The merchant terms in force accepted (MT2)' })
  async acceptTerms(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: acceptMerchantTermsSchema }) body: AcceptMerchantTerms,
    @Req() request: Request,
  ) {
    await this.merchants.acceptTerms(customer.id, body.versionId, requestMeta(request));
  }
}
