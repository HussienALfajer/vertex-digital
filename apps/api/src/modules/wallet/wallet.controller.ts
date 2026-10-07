import { Controller, Get, Header, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type WalletEntryQuery,
  walletEntryPageSchema,
  walletEntryQuerySchema,
  walletSchema,
} from '@vertex-digital/contracts';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import type { CustomerIdentity } from '../auth/index.js';
import { WalletService } from './wallet.service.js';

/** The customer's own wallet (S02): no customer id in the routes, never cached (rule W10). */
@ApiTags('wallet')
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: walletSchema })
  @ApiOkResponse({ description: 'The balance', standardSchema: walletSchema })
  wallet(@CurrentCustomer() customer: CustomerIdentity) {
    return this.wallets.wallet(customer.id);
  }

  @Get('entries')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(walletEntryQuerySchema)
  @SerializeOptions({ schema: walletEntryPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: walletEntryPageSchema })
  entries(
    @CurrentCustomer() customer: CustomerIdentity,
    @Query({ schema: walletEntryQuerySchema }) query: WalletEntryQuery,
  ) {
    return this.wallets.entries(customer.id, query);
  }
}
