import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type CreateProductAlert,
  createProductAlertSchema,
  type ProductAlertListQuery,
  productAlertListQuerySchema,
  productAlertListSchema,
  productAlertSchema,
} from '@vertex-digital/contracts';
import type { Response } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import type { CustomerIdentity } from '../auth/index.js';
import { ProductAlertsService } from './product-alerts.service.js';

/**
 * The customer's availability and price-drop alerts (S22 PA1, PA7): the customer's own only,
 * never cached. Frozen customers may set them (freezing blocks money only).
 */
@ApiTags('catalog')
@Controller('product-alerts')
export class ProductAlertsController {
  constructor(private readonly alerts: ProductAlertsService) {}

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @ApiQueryOf(productAlertListQuerySchema)
  @SerializeOptions({ schema: productAlertListSchema })
  @ApiOkResponse({ description: 'The alerts', standardSchema: productAlertListSchema })
  list(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: productAlertListQuerySchema }) query: ProductAlertListQuery,
  ) {
    return this.alerts.list(customer.id, query);
  }

  @Post()
  @CustomerRoute()
  @SerializeOptions({ schema: productAlertSchema })
  @ApiCreatedResponse({
    description: 'Set (200: the active alert of that kind)',
    standardSchema: productAlertSchema,
  })
  async create(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: createProductAlertSchema }) body: CreateProductAlert,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { alert, created } = await this.alerts.create(customer.id, body);
    response.status(created ? 201 : 200);
    return alert;
  }

  @Delete(':id')
  @CustomerRoute()
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Cancelled' })
  async cancel(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.alerts.cancel(customer.id, id);
  }
}
