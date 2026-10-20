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
} from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type ApproveApplication,
  adminCustomerSchema,
  adminMerchantApplicationPageSchema,
  adminMerchantApplicationSchema,
  adminMerchantPageSchema,
  approveApplicationSchema,
  type GrantMerchant,
  grantMerchantSchema,
  type MerchantApplicationListQuery,
  type MerchantListQuery,
  type MerchantSettingsInput,
  merchantApplicationListQuerySchema,
  merchantListQuerySchema,
  merchantSettingsInputSchema,
  merchantSettingsSchema,
  type RejectApplication,
  type RequestApplicationInfo,
  type RevokeMerchant,
  rejectApplicationSchema,
  requestApplicationInfoSchema,
  revokeMerchantSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { sendImage } from '../files/index.js';
import { MerchantsAdminService } from './merchants-admin.service.js';

/**
 * Merchants in the panel (S20 F28): the applications queue and decisions, the direct grant and the
 * revocation, the merchants list and the merchant settings. An approval, a grant, a revocation
 * and a settings change re-authenticate (Access).
 */
@ApiTags('merchants')
@Controller('admin')
export class MerchantsAdminController {
  constructor(private readonly merchants: MerchantsAdminService) {}

  @Get('merchant-applications')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(merchantApplicationListQuerySchema)
  @SerializeOptions({ schema: adminMerchantApplicationPageSchema })
  @ApiOkResponse({
    description: 'Under review oldest first, otherwise newest first (MA8)',
    standardSchema: adminMerchantApplicationPageSchema,
  })
  queue(
    @Query({ schema: merchantApplicationListQuerySchema }) query: MerchantApplicationListQuery,
  ) {
    return this.merchants.queue(query);
  }

  @Get('merchant-applications/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminMerchantApplicationSchema })
  @ApiOkResponse({ description: 'The application', standardSchema: adminMerchantApplicationSchema })
  detail(@Param('id') id: string) {
    return this.merchants.detail(id);
  }

  @Get('merchant-applications/:id/photo')
  @AdminRoute()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'The shop photo (MA3)' })
  async photo(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    return sendImage(response, await this.merchants.photo(id), 'no-store');
  }

  @Post('merchant-applications/:id/request-info')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: adminMerchantApplicationSchema })
  @ApiOkResponse({
    description: 'Waiting for information',
    standardSchema: adminMerchantApplicationSchema,
  })
  requestInfo(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: requestApplicationInfoSchema }) body: RequestApplicationInfo,
    @Req() request: Request,
  ) {
    return this.merchants.decide(id, 'request_info', body.message, {
      adminId: admin.id,
      meta: requestMeta(request),
    });
  }

  @Post('merchant-applications/:id/reject')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: adminMerchantApplicationSchema })
  @ApiOkResponse({ description: 'Rejected', standardSchema: adminMerchantApplicationSchema })
  reject(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: rejectApplicationSchema }) body: RejectApplication,
    @Req() request: Request,
  ) {
    return this.merchants.decide(id, 'reject', body.reason, {
      adminId: admin.id,
      meta: requestMeta(request),
    });
  }

  @Post('merchant-applications/:id/approve')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminMerchantApplicationSchema })
  @ApiOkResponse({ description: 'Approved (MA5)', standardSchema: adminMerchantApplicationSchema })
  approve(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: approveApplicationSchema }) body: ApproveApplication,
    @Req() request: Request,
  ) {
    return this.merchants.approve(id, body.priceListId, {
      adminId: admin.id,
      meta: requestMeta(request),
    });
  }

  @Get('merchants')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(merchantListQuerySchema)
  @SerializeOptions({ schema: adminMerchantPageSchema })
  @ApiOkResponse({
    description: 'Merchants, newest grant first',
    standardSchema: adminMerchantPageSchema,
  })
  list(@Query({ schema: merchantListQuerySchema }) query: MerchantListQuery) {
    return this.merchants.merchants(query);
  }

  /** MA6. */
  @Post('customers/:id/merchant')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({
    description: 'The profile, now a merchant',
    standardSchema: adminCustomerSchema,
  })
  grant(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: grantMerchantSchema }) body: GrantMerchant,
    @Req() request: Request,
  ) {
    return this.merchants.grant(id, body, { adminId: admin.id, meta: requestMeta(request) });
  }

  /** MA7. */
  @Post('customers/:id/merchant/revoke')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: adminCustomerSchema })
  @ApiOkResponse({
    description: 'The profile, a customer again',
    standardSchema: adminCustomerSchema,
  })
  revoke(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: revokeMerchantSchema }) body: RevokeMerchant,
    @Req() request: Request,
  ) {
    return this.merchants.revoke(id, body.reason, {
      adminId: admin.id,
      meta: requestMeta(request),
    });
  }

  @Get('merchant-settings')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantSettingsSchema })
  @ApiOkResponse({ description: 'The settings in force', standardSchema: merchantSettingsSchema })
  settings() {
    return this.merchants.settings();
  }

  @Put('merchant-settings')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: merchantSettingsSchema })
  @ApiOkResponse({ description: 'The new version', standardSchema: merchantSettingsSchema })
  saveSettings(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: merchantSettingsInputSchema }) body: MerchantSettingsInput,
    @Req() request: Request,
  ) {
    return this.merchants.saveSettings(body, { adminId: admin.id, meta: requestMeta(request) });
  }
}
