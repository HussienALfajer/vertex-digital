import {
  Body,
  Controller,
  Delete,
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
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type CreatePriceList,
  createPriceListSchema,
  fixedPriceSchema,
  type PriceMatrixQuery,
  priceListDetailSchema,
  priceListSchema,
  priceMatrixQuerySchema,
  priceMatrixSchema,
  type RenamePriceList,
  renamePriceListSchema,
  type SetFixedPrice,
  setFixedPriceSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { PriceListsService } from './price-lists.service.js';

/**
 * Price lists (S20 F29): the lists, a list's page, its fixed prices and the matrix. Every change
 * re-authenticates (LS6); the service refreshes the store for a retail fixed price only.
 */
@ApiTags('pricing')
@Controller('admin/pricing')
export class PriceListsAdminController {
  constructor(private readonly lists: PriceListsService) {}

  @Get('lists')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: priceListSchema })
  @ApiOkResponse({ description: 'Every list', standardSchema: priceListSchema.array() })
  all() {
    return this.lists.lists();
  }

  /** LS1–LS3, RP3. */
  @Post('lists')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: priceListSchema })
  @ApiCreatedResponse({ description: 'The new list, priced', standardSchema: priceListSchema })
  create(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: createPriceListSchema }) body: CreatePriceList,
    @Req() request: Request,
  ) {
    return this.lists.create({ adminId: admin.id, meta: requestMeta(request) }, body);
  }

  @Get('lists/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: priceListDetailSchema })
  @ApiOkResponse({ description: 'The list page', standardSchema: priceListDetailSchema })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.lists.detail(id);
  }

  @Patch('lists/:id')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: priceListSchema })
  @ApiOkResponse({ description: 'The renamed list', standardSchema: priceListSchema })
  rename(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: renamePriceListSchema }) body: RenamePriceList,
    @Req() request: Request,
  ) {
    return this.lists.rename({ adminId: admin.id, meta: requestMeta(request) }, id, body.name);
  }

  /** LS5. */
  @Post('lists/:id/archive')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: priceListSchema })
  @ApiOkResponse({ description: 'The archived list', standardSchema: priceListSchema })
  archive(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.lists.archive({ adminId: admin.id, meta: requestMeta(request) }, id);
  }

  /** LS2, LP1. */
  @Put('lists/:id/fixed-prices/:productId')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: fixedPriceSchema })
  @ApiOkResponse({
    description: 'The fixed price and the list’s resulting price',
    standardSchema: fixedPriceSchema,
  })
  setFixedPrice(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body({ schema: setFixedPriceSchema }) body: SetFixedPrice,
    @Req() request: Request,
  ) {
    return this.lists.setFixedPrice(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      productId,
      body.priceUsdUnits,
    );
  }

  /** Archives the fixed price; the list's rules apply again. */
  @Delete('lists/:id/fixed-prices/:productId')
  @AdminRoute()
  @Sensitive()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'Archived' })
  archiveFixedPrice(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Req() request: Request,
  ) {
    return this.lists.archiveFixedPrice(
      { adminId: admin.id, meta: requestMeta(request) },
      id,
      productId,
    );
  }

  @Get('matrix')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(priceMatrixQuerySchema)
  @SerializeOptions({ schema: priceMatrixSchema })
  @ApiOkResponse({ description: 'Products × lists', standardSchema: priceMatrixSchema })
  matrix(@Query({ schema: priceMatrixQuerySchema }) query: PriceMatrixQuery) {
    return this.lists.matrix(query);
  }
}
