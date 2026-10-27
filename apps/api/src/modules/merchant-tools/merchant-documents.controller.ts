import { Controller, Get, Header, Param, Query, Res, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type MerchantPriceListQuery,
  merchantPriceListQuerySchema,
  merchantPriceListSchema,
  statementMonthsSchema,
  statementSchema,
} from '@vertex-digital/contracts';
import type { Response } from 'express';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import type { CustomerIdentity } from '../auth/index.js';
import { MerchantDocumentsService } from './merchant-documents.service.js';

/**
 * The merchant's documents (S21 F36, F38): the price list and the monthly statement. Merchants
 * only, never cached; a merchant reads only their own prices and wallet.
 */
@ApiTags('merchant-tools')
@Controller('merchant')
export class MerchantDocumentsController {
  constructor(private readonly documents: MerchantDocumentsService) {}

  @Get('price-list')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(merchantPriceListQuerySchema)
  @SerializeOptions({ schema: merchantPriceListSchema })
  @ApiOkResponse({
    description: 'The price list to print (PL1, PL2)',
    standardSchema: merchantPriceListSchema,
  })
  priceList(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: merchantPriceListQuerySchema }) query: MerchantPriceListQuery,
  ) {
    return this.documents.priceList(customer.id, query);
  }

  /** PL3: one image of at most 60 packs (`page`), 20 an hour. */
  @Get('price-list.png')
  @CustomerRoute()
  @ApiProduces('image/png')
  @ApiQueryOf(merchantPriceListQuerySchema)
  @ApiOkResponse({ description: '1080 px wide, PNG' })
  async priceListImage(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: merchantPriceListQuerySchema }) query: MerchantPriceListQuery,
    @Res() response: Response,
  ) {
    const png = await this.documents.priceListImage(customer.id, query);
    response
      .status(200)
      .set({
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="price-list-${query.page}.png"`,
        'x-content-type-options': 'nosniff',
      })
      .send(png);
  }

  @Get('statements')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: statementMonthsSchema })
  @ApiOkResponse({
    description: 'The months available (ST1)',
    standardSchema: statementMonthsSchema,
  })
  statements(@CurrentCustomer() customer: CustomerIdentity) {
    return this.documents.statements(customer.id);
  }

  @Get('statements/:month')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: statementSchema })
  @ApiOkResponse({ description: 'The month’s statement (ST2)', standardSchema: statementSchema })
  statement(@CurrentCustomer() customer: CustomerIdentity, @Param('month') month: string) {
    return this.documents.statementPage(customer.id, month);
  }

  /** ST3: the statement as an `.xlsx`, 20 an hour. */
  @Get('statements/:month/export')
  @CustomerRoute()
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ description: 'The statement as an .xlsx file' })
  async export(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('month') month: string,
    @Res() response: Response,
  ) {
    const file = await this.documents.statementExport(customer.id, month);
    response
      .status(200)
      .set({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${file.fileName}"`,
      })
      .send(file.body);
  }
}
