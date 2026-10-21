import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Put,
  Query,
  SerializeOptions,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type AlertSettings,
  alertSettingsSchema,
  type MerchantAlertQuery,
  type MerchantDashboardQuery,
  merchantAlertPageSchema,
  merchantAlertQuerySchema,
  merchantDashboardQuerySchema,
  merchantDashboardSchema,
  merchantGamesSchema,
  type SellingPriceInput,
  type SellingPriceQuery,
  type SellingSettings,
  sellingPriceInputSchema,
  sellingPriceQuerySchema,
  sellingPriceRowSchema,
  sellingPricesSchema,
  sellingSettingsSchema,
  type UpdateWatches,
  updateWatchesSchema,
  watchesSchema,
} from '@vertex-digital/contracts';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import type { CustomerIdentity } from '../auth/index.js';
import { MerchantToolsService } from './merchant-tools.service.js';

/**
 * The merchant area (S21 F30, F31, F37): merchants only, never cached; a merchant reaches only
 * their own figures, prices, follows and settings.
 */
@ApiTags('merchant-tools')
@Controller('merchant')
export class MerchantToolsController {
  constructor(private readonly tools: MerchantToolsService) {}

  @Get('dashboard')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(merchantDashboardQuerySchema)
  @SerializeOptions({ schema: merchantDashboardSchema })
  @ApiOkResponse({
    description: 'Today or this month (DB1–DB5)',
    standardSchema: merchantDashboardSchema,
  })
  dashboard(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: merchantDashboardQuerySchema }) query: MerchantDashboardQuery,
  ) {
    return this.tools.dashboard(customer.id, query);
  }

  @Get('games')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantGamesSchema })
  @ApiOkResponse({ description: 'The store’s games', standardSchema: merchantGamesSchema })
  games(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tools.games(customer.id);
  }

  @Get('selling-settings')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: sellingSettingsSchema })
  @ApiOkResponse({
    description: 'The markup and SYP step (SP1)',
    standardSchema: sellingSettingsSchema,
  })
  sellingSettings(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tools.sellingSettings(customer.id);
  }

  @Put('selling-settings')
  @CustomerRoute()
  @SerializeOptions({ schema: sellingSettingsSchema })
  @ApiOkResponse({ description: 'The saved settings', standardSchema: sellingSettingsSchema })
  saveSellingSettings(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: sellingSettingsSchema }) body: SellingSettings,
  ) {
    return this.tools.saveSellingSettings(customer.id, body);
  }

  @Get('selling-prices')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(sellingPriceQuerySchema)
  @SerializeOptions({ schema: sellingPricesSchema })
  @ApiOkResponse({ description: 'A game’s packs (SP3)', standardSchema: sellingPricesSchema })
  sellingPrices(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: sellingPriceQuerySchema }) query: SellingPriceQuery,
  ) {
    return this.tools.sellingPrices(customer.id, query.gameId);
  }

  @Put('selling-prices/:productId')
  @CustomerRoute()
  @SerializeOptions({ schema: sellingPriceRowSchema })
  @ApiOkResponse({
    description: 'The pack with its price (SP2)',
    standardSchema: sellingPriceRowSchema,
  })
  setSellingPrice(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('productId') productId: string,
    @Body({ schema: sellingPriceInputSchema }) body: SellingPriceInput,
  ) {
    return this.tools.setSellingPrice(customer.id, productId, body);
  }

  @Delete('selling-prices/:productId')
  @CustomerRoute()
  @SerializeOptions({ schema: sellingPriceRowSchema })
  @ApiOkResponse({
    description: 'The pack back on the markup',
    standardSchema: sellingPriceRowSchema,
  })
  clearSellingPrice(
    @CurrentCustomer() customer: CustomerIdentity,
    @Param('productId') productId: string,
  ) {
    return this.tools.clearSellingPrice(customer.id, productId);
  }

  @Get('watches')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: watchesSchema })
  @ApiOkResponse({ description: 'Follows and suggestions (AL1)', standardSchema: watchesSchema })
  watches(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tools.watches(customer.id);
  }

  @Put('watches')
  @CustomerRoute()
  @SerializeOptions({ schema: watchesSchema })
  @ApiOkResponse({ description: 'The saved follows', standardSchema: watchesSchema })
  saveWatches(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: updateWatchesSchema }) body: UpdateWatches,
  ) {
    return this.tools.saveWatches(customer.id, body);
  }

  @Get('alerts')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(merchantAlertQuerySchema)
  @SerializeOptions({ schema: merchantAlertPageSchema })
  @ApiOkResponse({
    description: 'The last 90 days of alerts',
    standardSchema: merchantAlertPageSchema,
  })
  alerts(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: merchantAlertQuerySchema }) query: MerchantAlertQuery,
  ) {
    return this.tools.alerts(customer.id, query);
  }

  @Get('alert-settings')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: alertSettingsSchema })
  @ApiOkResponse({
    description: 'The alert settings (AL4, AL5)',
    standardSchema: alertSettingsSchema,
  })
  alertSettings(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tools.alertSettings(customer.id);
  }

  @Put('alert-settings')
  @CustomerRoute()
  @SerializeOptions({ schema: alertSettingsSchema })
  @ApiOkResponse({ description: 'The saved settings', standardSchema: alertSettingsSchema })
  saveAlertSettings(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: alertSettingsSchema }) body: AlertSettings,
  ) {
    return this.tools.saveAlertSettings(customer.id, body);
  }
}
