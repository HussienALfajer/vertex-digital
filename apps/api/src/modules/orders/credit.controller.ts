import { Controller, Get, Header, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { creditLimitsSchema } from '@vertex-digital/contracts';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import type { CustomerIdentity } from '../auth/index.js';
import { CreditService } from './credit.service.js';

/** S25: what the signed-in customer may still spend in "الرصيد والفواتير", never cached. */
@ApiTags('orders')
@Controller('credit-limits')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Get()
  @CustomerRoute()
  @Header('cache-control', 'private, no-store')
  @SerializeOptions({ schema: creditLimitsSchema })
  @ApiOkResponse({ description: 'The remaining amounts', standardSchema: creditLimitsSchema })
  limits(@CurrentCustomer() customer: CustomerIdentity) {
    return this.credit.limits(customer.id);
  }
}
