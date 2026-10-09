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
  importOffersSchema,
  importResultSchema,
  type OfferListQuery,
  offerCostChangePageSchema,
  offerListQuerySchema,
  type PageQuery,
  pageQuerySchema,
  type SetSupplierCredentials,
  type SupplierPolicy,
  setSupplierCredentialsSchema,
  supplierDetailSchema,
  supplierOfferPageSchema,
  supplierPolicySchema,
  supplierSummarySchema,
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
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierSummarySchema })
  @ApiOkResponse({ description: 'One per supplier', standardSchema: supplierSummarySchema.array() })
  list() {
    return this.suppliers.list();
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
