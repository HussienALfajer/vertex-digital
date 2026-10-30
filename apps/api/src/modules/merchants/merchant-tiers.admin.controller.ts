import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  merchantTierListSchema,
  merchantTierViewSchema,
  type TierGrantEndInput,
  type TierGrantInput,
  type TierLevelInput,
  type TierPreviewInput,
  type TierSettingsInput,
  tierBestSellersSchema,
  tierGrantEndInputSchema,
  tierGrantInputSchema,
  tierGrantSchema,
  tierLevelInputSchema,
  tierPreviewInputSchema,
  tierPreviewSchema,
  tierSettingsInputSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { MerchantTiersService } from './merchant-tiers.service.js';

/**
 * Merchant tiers in the panel (S23 F43): the tiers page, a tier's level and settings, the
 * threshold preview, and a merchant's manual grant. Every change re-authenticates (Access).
 */
@ApiTags('merchants')
@Controller('admin')
export class MerchantTiersAdminController {
  constructor(private readonly tiers: MerchantTiersService) {}

  @Get('merchant-tiers')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantTierListSchema })
  @ApiOkResponse({
    description: 'The four tiers with their levels, privileges and merchants',
    standardSchema: merchantTierListSchema,
  })
  list() {
    return this.tiers.list();
  }

  /** PX5: the Diamond best-sellers helper. */
  @Get('merchant-tiers/best-sellers')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: tierBestSellersSchema })
  @ApiOkResponse({
    description: 'The packs merchants bought most in 30 days with each tier price and margin',
    standardSchema: tierBestSellersSchema,
  })
  bestSellers() {
    return this.tiers.bestSellers();
  }

  @Put('merchant-tiers/:tier/level')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: merchantTierViewSchema })
  @ApiOkResponse({ description: 'The tier', standardSchema: merchantTierViewSchema })
  setLevel(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('tier') tier: string,
    @Body({ schema: tierLevelInputSchema }) body: TierLevelInput,
    @Req() request: Request,
  ) {
    return this.tiers.setLevel(tier, body, { adminId: admin.id, meta: requestMeta(request) });
  }

  @Put('merchant-tiers/:tier/settings')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: merchantTierViewSchema })
  @ApiOkResponse({ description: 'The tier', standardSchema: merchantTierViewSchema })
  saveSettings(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('tier') tier: string,
    @Body({ schema: tierSettingsInputSchema }) body: TierSettingsInput,
    @Req() request: Request,
  ) {
    return this.tiers.saveSettings(tier, body, { adminId: admin.id, meta: requestMeta(request) });
  }

  /** AD3: read only. */
  @Post('merchant-tiers/preview')
  @AdminRoute()
  @HttpCode(200)
  @SerializeOptions({ schema: tierPreviewSchema })
  @ApiOkResponse({
    description: 'Who would hold each tier, rise and fall',
    standardSchema: tierPreviewSchema,
  })
  preview(@Body({ schema: tierPreviewInputSchema }) body: TierPreviewInput) {
    return this.tiers.preview(body);
  }

  /** MG1. */
  @Post('customers/:id/merchant/tier-grant')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: tierGrantSchema })
  @ApiOkResponse({ description: 'The grant', standardSchema: tierGrantSchema })
  grant(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: tierGrantInputSchema }) body: TierGrantInput,
    @Req() request: Request,
  ) {
    return this.tiers.grant(id, body, { adminId: admin.id, meta: requestMeta(request) });
  }

  /** MG3. */
  @Post('customers/:id/merchant/tier-grant/end')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: tierGrantSchema })
  @ApiOkResponse({ description: 'The ended grant', standardSchema: tierGrantSchema })
  endGrant(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: tierGrantEndInputSchema }) body: TierGrantEndInput,
    @Req() request: Request,
  ) {
    return this.tiers.endGrant(id, body, { adminId: admin.id, meta: requestMeta(request) });
  }
}
