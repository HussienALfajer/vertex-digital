import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  SerializeOptions,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  createInputFieldSchema,
  createProductSchema,
  inputFieldSchema,
  productSchema,
  type Reorder,
  reorderSchema,
  type UpdateInputField,
  type UpdateProduct,
  updateInputFieldSchema,
  updateProductSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import type { AdminIdentity } from '../admin/index.js';
import { CatalogItemsService } from './catalog-items.service.js';
import type { Actor } from './catalog-records.js';

const actor = (admin: AdminIdentity, request: Request): Actor => ({
  adminId: admin.id,
  meta: requestMeta(request),
});

/** A game's input fields and products in the panel (S06 rules CT7, CT8). Never cached. */
@ApiTags('catalog')
@UseInterceptors(StoreRevalidateInterceptor)
@Controller('admin/catalog')
export class CatalogItemsAdminController {
  constructor(private readonly items: CatalogItemsService) {}

  // Input fields ----------------------------------------------------------------------------------

  @Post('games/:id/fields')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: inputFieldSchema })
  @ApiCreatedResponse({ description: 'Last in the order', standardSchema: inputFieldSchema })
  createField(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: createInputFieldSchema }) body: z.output<typeof createInputFieldSchema>,
    @Req() request: Request,
  ) {
    return this.items.createField(actor(admin, request), id, body);
  }

  @Put('games/:id/fields/order')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: inputFieldSchema })
  @ApiOkResponse({ description: 'In their new order', standardSchema: inputFieldSchema.array() })
  reorderFields(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: reorderSchema }) body: Reorder,
    @Req() request: Request,
  ) {
    return this.items.reorderFields(actor(admin, request), id, body.ids);
  }

  @Patch('fields/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: inputFieldSchema })
  @ApiOkResponse({ description: 'The field', standardSchema: inputFieldSchema })
  updateField(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: updateInputFieldSchema }) body: UpdateInputField,
    @Req() request: Request,
  ) {
    return this.items.updateField(actor(admin, request), id, body);
  }

  @Post('fields/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: inputFieldSchema })
  @ApiOkResponse({ description: 'The field', standardSchema: inputFieldSchema })
  archiveField(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.items.archiveField(actor(admin, request), id);
  }

  @Post('fields/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: inputFieldSchema })
  @ApiOkResponse({ description: 'The field', standardSchema: inputFieldSchema })
  restoreField(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.items.restoreField(actor(admin, request), id);
  }

  // Products --------------------------------------------------------------------------------------

  @Post('games/:id/products')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productSchema })
  @ApiCreatedResponse({ description: 'Last in the order', standardSchema: productSchema })
  createProduct(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: createProductSchema }) body: z.output<typeof createProductSchema>,
    @Req() request: Request,
  ) {
    return this.items.createProduct(actor(admin, request), id, body);
  }

  @Put('games/:id/products/order')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productSchema })
  @ApiOkResponse({ description: 'In their new order', standardSchema: productSchema.array() })
  reorderProducts(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: reorderSchema }) body: Reorder,
    @Req() request: Request,
  ) {
    return this.items.reorderProducts(actor(admin, request), id, body.ids);
  }

  @Patch('products/:id')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productSchema })
  @ApiOkResponse({ description: 'The product', standardSchema: productSchema })
  updateProduct(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: updateProductSchema }) body: UpdateProduct,
    @Req() request: Request,
  ) {
    return this.items.updateProduct(actor(admin, request), id, body);
  }

  @Post('products/:id/archive')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productSchema })
  @ApiOkResponse({ description: 'The product', standardSchema: productSchema })
  archiveProduct(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.items.archiveProduct(actor(admin, request), id);
  }

  @Post('products/:id/restore')
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: productSchema })
  @ApiOkResponse({ description: 'The product', standardSchema: productSchema })
  restoreProduct(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.items.restoreProduct(actor(admin, request), id);
  }
}
