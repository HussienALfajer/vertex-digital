import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  SerializeOptions,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type CoverFromSupplier,
  categoryImportResultSchema,
  coverFromSupplierSchema,
  gameDetailSchema,
  type ImportDraftQuery,
  importCategorySchema,
  importDraftQuerySchema,
  importDraftSchema,
  type LinkCandidateQuery,
  linkCandidateQuerySchema,
  linkCandidateSchema,
  linkCategorySchema,
  platformStatusSchema,
  type StatementQuery,
  type SupplierCategoryListQuery,
  statementQuerySchema,
  supplierCategoryIdSchema,
  supplierCategoryListQuerySchema,
  supplierCategoryNodeSchema,
  supplierCategoryPageSchema,
  supplierOfferSchema,
  supplierOrderPageSchema,
  supplierTransactionPageSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import { CodedException } from '../../core/errors/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { AdminIdentity } from '../admin/index.js';
import type { Actor } from '../catalog/index.js';
import { SupplierCatalogService } from './supplier-catalog.service.js';
import { SupplierLiveService } from './supplier-live.service.js';
import { SuppliersService } from './suppliers.service.js';

const actor = (admin: AdminIdentity, request: Request): Actor => ({
  adminId: admin.id,
  meta: requestMeta(request),
});

/** A `:categoryId` that is a supplier's category id, else `NOT_FOUND`. */
const categoryIdOf = (value: string): string => {
  if (!supplierCategoryIdSchema.safeParse(value).success) {
    throw new CodedException(404, 'NOT_FOUND', 'No such category');
  }
  return value;
};

/**
 * The supplier catalog in the panel (S16 SC4–SC14, IM1–IM3, SF3, SF5): the tree, imports and
 * links, ignore states, images, the statement and the platform status. Never cached, but the
 * category images (IM1).
 */
@ApiTags('suppliers')
@UseInterceptors(StoreRevalidateInterceptor)
@Controller('admin')
export class SupplierCatalogAdminController {
  constructor(
    private readonly catalog: SupplierCatalogService,
    private readonly live: SupplierLiveService,
    private readonly suppliers: SuppliersService,
  ) {}

  @Get('suppliers/:code/categories')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(supplierCategoryListQuerySchema)
  @SerializeOptions({ schema: supplierCategoryPageSchema })
  @ApiOkResponse({ description: 'Rule SC4', standardSchema: supplierCategoryPageSchema })
  categories(
    @Param('code') code: string,
    @Query({ schema: supplierCategoryListQuerySchema }) query: SupplierCategoryListQuery,
  ) {
    return this.catalog.categories(code, query);
  }

  /** S18: one node with its path, for the category page's header. */
  @Get('suppliers/:code/categories/:categoryId')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierCategoryNodeSchema })
  @ApiOkResponse({ description: 'The node', standardSchema: supplierCategoryNodeSchema })
  category(@Param('code') code: string, @Param('categoryId') categoryId: string) {
    return this.catalog.node(code, categoryIdOf(categoryId));
  }

  /** IM1: through the API only; the panel never loads a supplier's host. */
  @Get('suppliers/:code/categories/:categoryId/image')
  @AdminRoute()
  @RateLimit({ limit: 120, perSeconds: 60 })
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'A thumbnail (WebP, at most 256 px)' })
  async image(
    @Param('code') code: string,
    @Param('categoryId') categoryId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const webp = await this.live.thumbnail(code, categoryIdOf(categoryId));
    if (!webp) throw new CodedException(404, 'NOT_FOUND', 'No image for this category');
    response.setHeader('cache-control', 'private, max-age=86400');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-disposition', 'inline');
    return new StreamableFile(webp, { type: 'image/webp' });
  }

  @Get('suppliers/:code/categories/:categoryId/import-draft')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(importDraftQuerySchema)
  @SerializeOptions({ schema: importDraftSchema })
  @ApiOkResponse({ description: 'Rules SC7, SC8, SC12–SC14', standardSchema: importDraftSchema })
  draft(
    @Param('code') code: string,
    @Param('categoryId') categoryId: string,
    @Query({ schema: importDraftQuerySchema }) query: ImportDraftQuery,
  ) {
    return this.catalog.draft(code, categoryIdOf(categoryId), query.gameId);
  }

  @Post('suppliers/:code/categories/:categoryId/import')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: categoryImportResultSchema })
  @ApiCreatedResponse({
    description: 'A paused game with its packs (rule SC7)',
    standardSchema: categoryImportResultSchema,
  })
  importCategory(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Param('categoryId') categoryId: string,
    @Body({ schema: importCategorySchema }) body: z.output<typeof importCategorySchema>,
    @Req() request: Request,
  ) {
    return this.catalog.importCategory(actor(admin, request), code, categoryIdOf(categoryId), body);
  }

  @Post('suppliers/:code/categories/:categoryId/link')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: categoryImportResultSchema })
  @ApiCreatedResponse({
    description: 'The node linked to the game (rule SC8)',
    standardSchema: categoryImportResultSchema,
  })
  link(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Param('categoryId') categoryId: string,
    @Body({ schema: linkCategorySchema }) body: z.output<typeof linkCategorySchema>,
    @Req() request: Request,
  ) {
    return this.catalog.linkCategory(actor(admin, request), code, categoryIdOf(categoryId), body);
  }

  @Post('suppliers/:code/categories/:categoryId/unlink')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierCategoryNodeSchema })
  @ApiOkResponse({ description: 'Rule SC9', standardSchema: supplierCategoryNodeSchema })
  unlink(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Param('categoryId') categoryId: string,
    @Req() request: Request,
  ) {
    return this.catalog.unlink(actor(admin, request), code, categoryIdOf(categoryId));
  }

  @Post('suppliers/:code/categories/:categoryId/ignore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierCategoryNodeSchema })
  @ApiOkResponse({ description: 'Rule SC6', standardSchema: supplierCategoryNodeSchema })
  ignore(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Param('categoryId') categoryId: string,
    @Req() request: Request,
  ) {
    return this.catalog.setIgnored(actor(admin, request), code, categoryIdOf(categoryId), true);
  }

  @Post('suppliers/:code/categories/:categoryId/unignore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierCategoryNodeSchema })
  @ApiOkResponse({ description: 'Rule SC6', standardSchema: supplierCategoryNodeSchema })
  unignore(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('code') code: string,
    @Param('categoryId') categoryId: string,
    @Req() request: Request,
  ) {
    return this.catalog.setIgnored(actor(admin, request), code, categoryIdOf(categoryId), false);
  }

  /** S18: the store packs an offer may be linked to, suggested first. */
  @Get('suppliers/offers/:id/link-candidates')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(linkCandidateQuerySchema)
  @SerializeOptions({ schema: linkCandidateSchema })
  @ApiOkResponse({ description: 'At most 20', standardSchema: linkCandidateSchema.array() })
  linkCandidates(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query({ schema: linkCandidateQuerySchema }) query: LinkCandidateQuery,
  ) {
    return this.catalog.linkCandidates(id, query);
  }

  @Post('suppliers/offers/:id/ignore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierOfferSchema })
  @ApiOkResponse({ description: 'Rule SC6', standardSchema: supplierOfferSchema })
  async ignoreOffer(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.suppliers.offer(
      await this.catalog.setOfferIgnored(actor(admin, request), id, true),
    );
  }

  @Post('suppliers/offers/:id/unignore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierOfferSchema })
  @ApiOkResponse({ description: 'Rule SC6', standardSchema: supplierOfferSchema })
  async unignoreOffer(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.suppliers.offer(
      await this.catalog.setOfferIgnored(actor(admin, request), id, false),
    );
  }

  /** The supplier categories linked to a game (the game page: SC9, IM3). */
  @Get('catalog/games/:id/supplier-categories')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: supplierCategoryNodeSchema })
  @ApiOkResponse({
    description: 'Nodes linked to the game itself',
    standardSchema: supplierCategoryNodeSchema.array(),
  })
  gameCategories(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.gameCategories(id);
  }

  /** IM3: the linked category's image, downloaded again, as the game's cover. */
  @Post('catalog/games/:id/cover/from-supplier')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gameDetailSchema })
  @ApiOkResponse({ description: 'Rule IM3', standardSchema: gameDetailSchema })
  cover(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: coverFromSupplierSchema }) body: CoverFromSupplier,
    @Req() request: Request,
  ) {
    return this.catalog.coverFromSupplier(
      actor(admin, request),
      id,
      body.supplier,
      body.categoryId,
    );
  }

  @Get('suppliers/:code/statement/transactions')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(statementQuerySchema)
  @SerializeOptions({ schema: supplierTransactionPageSchema })
  @ApiOkResponse({ description: 'Rule SF3', standardSchema: supplierTransactionPageSchema })
  transactions(
    @Param('code') code: string,
    @Query({ schema: statementQuerySchema }) query: StatementQuery,
  ) {
    return this.live.transactions(code, query.page);
  }

  @Get('suppliers/:code/statement/orders')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(statementQuerySchema)
  @SerializeOptions({ schema: supplierOrderPageSchema })
  @ApiOkResponse({ description: 'Rule SF3', standardSchema: supplierOrderPageSchema })
  orders(
    @Param('code') code: string,
    @Query({ schema: statementQuerySchema }) query: StatementQuery,
  ) {
    return this.live.orders(code, query.page);
  }

  @Get('suppliers/:code/platform-status')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: platformStatusSchema })
  @ApiOkResponse({ description: 'Rule SF5', standardSchema: platformStatusSchema })
  platformStatus(@Param('code') code: string) {
    return this.live.platformStatus(code);
  }
}
