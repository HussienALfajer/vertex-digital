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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CATALOG_IMAGE_MAX_BYTES,
  type CategoryListQuery,
  catalogImageSchema,
  categoryListQuerySchema,
  categorySchema,
  createCategorySchema,
  createGameSchema,
  type GameListQuery,
  gameDetailSchema,
  gameListQuerySchema,
  gamePageSchema,
  gameSchema,
  type Reorder,
  reorderSchema,
  type UpdateCategory,
  type UpdateGame,
  updateCategorySchema,
  updateGameSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { AdminIdentity } from '../admin/index.js';
import { uploadBody } from '../files/index.js';
import { CatalogService } from './catalog.service.js';
import type { Actor } from './catalog-records.js';

const imageUpload = FileInterceptor('file', {
  limits: { fileSize: CATALOG_IMAGE_MAX_BYTES, files: 1, fields: 0 },
});

const actor = (admin: AdminIdentity, request: Request): Actor => ({
  adminId: admin.id,
  meta: requestMeta(request),
});

/** The catalog in the panel (S06, F08): images, categories and games. Never cached. */
@ApiTags('catalog')
@UseInterceptors(StoreRevalidateInterceptor)
@Controller('admin/catalog')
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogService) {}

  /** Rule CT10: re-encoded to WebP; the game form saves the returned id. */
  @Post('images')
  @AdminRoute()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @UseInterceptors(imageUpload)
  @Header('cache-control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody(uploadBody())
  @SerializeOptions({ schema: catalogImageSchema })
  @ApiCreatedResponse({ description: 'The stored image', standardSchema: catalogImageSchema })
  uploadImage(@UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.catalog.uploadImage(file?.buffer);
  }

  // Categories ------------------------------------------------------------------------------------

  @Get('categories')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(categoryListQuerySchema)
  @SerializeOptions({ schema: categorySchema })
  @ApiOkResponse({ description: 'In their order', standardSchema: categorySchema.array() })
  categories(@Query({ schema: categoryListQuerySchema }) query: CategoryListQuery) {
    return this.catalog.categories(query);
  }

  @Post('categories')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: categorySchema })
  @ApiCreatedResponse({ description: 'Last in the order', standardSchema: categorySchema })
  createCategory(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: createCategorySchema }) body: z.output<typeof createCategorySchema>,
    @Req() request: Request,
  ) {
    return this.catalog.createCategory(actor(admin, request), body);
  }

  @Put('categories/order')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: categorySchema })
  @ApiOkResponse({ description: 'In their new order', standardSchema: categorySchema.array() })
  reorderCategories(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: reorderSchema }) body: Reorder,
    @Req() request: Request,
  ) {
    return this.catalog.reorderCategories(actor(admin, request), body.ids);
  }

  @Patch('categories/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: categorySchema })
  @ApiOkResponse({ description: 'The category', standardSchema: categorySchema })
  updateCategory(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: updateCategorySchema }) body: UpdateCategory,
    @Req() request: Request,
  ) {
    return this.catalog.updateCategory(actor(admin, request), id, body);
  }

  @Post('categories/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: categorySchema })
  @ApiOkResponse({ description: 'The category', standardSchema: categorySchema })
  archiveCategory(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.catalog.archiveCategory(actor(admin, request), id);
  }

  @Post('categories/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: categorySchema })
  @ApiOkResponse({ description: 'The category', standardSchema: categorySchema })
  restoreCategory(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.catalog.restoreCategory(actor(admin, request), id);
  }

  @Put('categories/:id/games/order')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gameSchema })
  @ApiOkResponse({ description: 'In their new order', standardSchema: gameSchema.array() })
  reorderGames(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: reorderSchema }) body: Reorder,
    @Req() request: Request,
  ) {
    return this.catalog.reorderGames(actor(admin, request), id, body.ids);
  }

  // Games -----------------------------------------------------------------------------------------

  @Get('games')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(gameListQuerySchema)
  @SerializeOptions({ schema: gamePageSchema })
  @ApiOkResponse({ description: 'A page of games', standardSchema: gamePageSchema })
  games(@Query({ schema: gameListQuerySchema }) query: GameListQuery) {
    return this.catalog.games(query);
  }

  @Post('games')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gameDetailSchema })
  @ApiCreatedResponse({
    description: 'Paused, last in its category',
    standardSchema: gameDetailSchema,
  })
  createGame(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: createGameSchema }) body: z.output<typeof createGameSchema>,
    @Req() request: Request,
  ) {
    return this.catalog.createGame(actor(admin, request), body);
  }

  @Get('games/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gameDetailSchema })
  @ApiOkResponse({ description: 'With every field and product', standardSchema: gameDetailSchema })
  game(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.game(id);
  }

  @Patch('games/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gameDetailSchema })
  @ApiOkResponse({ description: 'The game', standardSchema: gameDetailSchema })
  updateGame(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: updateGameSchema }) body: UpdateGame,
    @Req() request: Request,
  ) {
    return this.catalog.updateGame(actor(admin, request), id, body);
  }

  @Post('games/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gameDetailSchema })
  @ApiOkResponse({ description: 'The game', standardSchema: gameDetailSchema })
  archiveGame(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.catalog.archiveGame(actor(admin, request), id);
  }

  @Post('games/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gameDetailSchema })
  @ApiOkResponse({ description: 'The game', standardSchema: gameDetailSchema })
  restoreGame(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.catalog.restoreGame(actor(admin, request), id);
  }
}
