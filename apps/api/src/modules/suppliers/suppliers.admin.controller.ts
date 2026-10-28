import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  SerializeOptions,
  UseInterceptors,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type BadgeCount,
  badgeCountSchema,
  checkCategoryListSchema,
  importOffersSchema,
  importResultSchema,
  type OfferListQuery,
  offerCostChangePageSchema,
  offerListQuerySchema,
  type PageQuery,
  pageQuerySchema,
  type SetSupplierCredentials,
  type SupplierCallListQuery,
  type SupplierPolicy,
  setSupplierCredentialsSchema,
  supplierCallListQuerySchema,
  supplierCallPageSchema,
  supplierConnectionTestSchema,
  supplierDetailSchema,
  supplierOfferPageSchema,
  supplierPolicySchema,
  supplierSummarySchema,
  supplierWebhookSettingsSchema,
  supplierWebhookTestSchema,
  syncRunPageSchema,
  syncRunSchema,
  type UpdateSupplier,
  updateSupplierSchema,
  type ValidationQuota,
  validationQuotaSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import type { AdminIdentity } from '../admin/index.js';
import type { Actor } from '../catalog/index.js';
import { SupplierLiveService } from './supplier-live.service.js';
import { SuppliersService } from './suppliers.service.js';

const actor = (admin: AdminIdentity, request: Request): Actor => ({
  adminId: admin.id,
  meta: requestMeta(request),
});

/**
 * Suppliers in the panel (S07): never cached. Credentials, the threshold and the policy
 * re-authenticate; "sync now" is limited to one a minute per supplier in the service.
 */
@ApiTags('suppliers')
@UseInterceptors(StoreRevalidateInterceptor)
@Controller('admin/suppliers')
export class SuppliersAdminController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly live: SupplierLiveService,
  ) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierSummarySchema })
  @ApiOkResponse({ description: 'One per supplier', standardSchema: supplierSummarySchema.array() })
  list() {
    return this.suppliers.list();
  }

  // Before `:code`, which would take `new-packs` as a code.
  @Get('new-packs')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: badgeCountSchema })
  @ApiOkResponse({
    description:
      'The new packs of every visible supplier: the navigation badge (SC11, audit A10-25)',
    standardSchema: badgeCountSchema,
  })
  async newPacks(): Promise<BadgeCount> {
    return { count: await this.suppliers.newPacks() };
  }

  // Before `:code`, which would take `policy` as a code.
  @Get('policy')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierPolicySchema })
  @ApiOkResponse({ description: 'The policy in force', standardSchema: supplierPolicySchema })
  policy() {
    return this.suppliers.policy();
  }

  @Put('policy')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierPolicySchema })
  @ApiOkResponse({ description: 'The policy in force', standardSchema: supplierPolicySchema })
  setPolicy(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: supplierPolicySchema }) body: SupplierPolicy,
    @Req() request: Request,
  ) {
    return this.suppliers.setPolicy(actor(admin, request), body);
  }

  @Get('offers/:id/costs')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(pageQuerySchema)
  @SerializeOptions({ schema: offerCostChangePageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: offerCostChangePageSchema })
  offerCosts(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query({ schema: pageQuerySchema }) query: PageQuery,
  ) {
    return this.suppliers.offerCosts(id, query);
  }

  @Get(':code')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierDetailSchema })
  @ApiOkResponse({ description: 'The supplier', standardSchema: supplierDetailSchema })
  detail(@Param('code') code: string) {
    return this.suppliers.detail(code);
  }

  /** S19 PC1: the supplier's player-check categories, for a game's check provider card. */
  @Get(':code/check-categories')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: checkCategoryListSchema })
  @ApiOkResponse({
    description: 'Read live, kept a minute',
    standardSchema: checkCategoryListSchema,
  })
  checkCategories(@Param('code') code: string) {
    return this.live.checkCategories(code);
  }

  /** S19 FC8: the supplier's webhook settings and last deliveries, read live. */
  @Get(':code/webhook')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierWebhookSettingsSchema })
  @ApiOkResponse({ description: 'Read live', standardSchema: supplierWebhookSettingsSchema })
  webhook(@Param('code') code: string) {
    return this.live.webhook(code);
  }

  /** S19 FC8: points the supplier's webhook at this store and sends its test event. */
  @Put(':code/webhook')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierWebhookSettingsSchema })
  @ApiOkResponse({ description: 'Read again live', standardSchema: supplierWebhookSettingsSchema })
  setWebhook(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Req() request: Request,
  ) {
    return this.live.setWebhook(actor(admin, request), code);
  }

  @Post(':code/webhook/test')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierWebhookTestSchema })
  @ApiOkResponse({ description: 'Whether it was sent', standardSchema: supplierWebhookTestSchema })
  testWebhook(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Req() request: Request,
  ) {
    return this.live.testWebhook(actor(admin, request), code);
  }

  /** Rule SP2: answered with hints only, never the values. */
  @Put(':code/credentials')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierDetailSchema })
  @ApiOkResponse({ description: 'The supplier', standardSchema: supplierDetailSchema })
  setCredentials(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Body({ schema: setSupplierCredentialsSchema }) body: SetSupplierCredentials,
    @Req() request: Request,
  ) {
    return this.suppliers.setCredentials(actor(admin, request), code, body);
  }

  @Patch(':code')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierDetailSchema })
  @ApiOkResponse({ description: 'The supplier', standardSchema: supplierDetailSchema })
  update(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Body({ schema: updateSupplierSchema }) body: UpdateSupplier,
    @Req() request: Request,
  ) {
    return this.suppliers.update(actor(admin, request), code, body);
  }

  /** S09 rule AD2: 0 turns player checks off for this supplier. */
  @Put(':code/validation-quota')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierDetailSchema })
  @ApiOkResponse({ description: 'The supplier', standardSchema: supplierDetailSchema })
  setValidationQuota(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Body({ schema: validationQuotaSchema }) body: ValidationQuota,
    @Req() request: Request,
  ) {
    return this.suppliers.setValidationQuota(actor(admin, request), code, body);
  }

  /** Rule SY1: the new run, or the one already running. */
  @Post(':code/sync')
  @AdminRoute()
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: syncRunSchema })
  @ApiAcceptedResponse({ description: 'The run', standardSchema: syncRunSchema })
  sync(@CurrentAdmin() admin: AdminIdentity, @Param('code') code: string, @Req() request: Request) {
    return this.suppliers.requestSync(actor(admin, request), code);
  }

  /** S18 CS1: one live balance read; once per 10 seconds per supplier. */
  @Post(':code/test')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierConnectionTestSchema })
  @ApiOkResponse({ description: 'The read', standardSchema: supplierConnectionTestSchema })
  testConnection(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Req() request: Request,
  ) {
    return this.live.testConnection(actor(admin, request), code);
  }

  /** S18 FK3: the recorded calls, newest first. */
  @Get(':code/calls')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(supplierCallListQuerySchema)
  @SerializeOptions({ schema: supplierCallPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: supplierCallPageSchema })
  calls(
    @Param('code') code: string,
    @Query({ schema: supplierCallListQuerySchema }) query: SupplierCallListQuery,
  ) {
    return this.suppliers.calls(code, query);
  }

  @Get(':code/runs')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(pageQuerySchema)
  @SerializeOptions({ schema: syncRunPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: syncRunPageSchema })
  runs(@Param('code') code: string, @Query({ schema: pageQuerySchema }) query: PageQuery) {
    return this.suppliers.runs(code, query);
  }

  @Get(':code/offers')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(offerListQuerySchema)
  @SerializeOptions({ schema: supplierOfferPageSchema })
  @ApiOkResponse({ description: 'A page of offers', standardSchema: supplierOfferPageSchema })
  offers(
    @Param('code') code: string,
    @Query({ schema: offerListQuerySchema }) query: OfferListQuery,
  ) {
    return this.suppliers.offers(code, query);
  }

  /** Rule RT8: all or nothing; a refusal lists its rows in `details.rows`. */
  @Post(':code/import')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: importResultSchema })
  @ApiCreatedResponse({ description: 'The paused products', standardSchema: importResultSchema })
  importOffers(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Body({ schema: importOffersSchema }) body: z.output<typeof importOffersSchema>,
    @Req() request: Request,
  ) {
    return this.suppliers.importOffers(actor(admin, request), code, body);
  }
}
