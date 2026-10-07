import { Body, Controller, Get, Patch, Req, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { customerProfileSchema, updateCustomerProfileSchema } from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { CurrentCustomer, CustomerRoute } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from './auth.service.js';
import { AuthAccountService } from './auth-account.service.js';

/** The customer's own profile (S01 rule C13). */
@ApiTags('account')
@Controller('account')
export class AuthAccountController {
  constructor(private readonly accounts: AuthAccountService) {}

  @Get()
  @CustomerRoute()
  @SerializeOptions({ schema: customerProfileSchema })
  @ApiOkResponse({ description: 'The profile', standardSchema: customerProfileSchema })
  profile(@CurrentCustomer() customer: CustomerIdentity) {
    return this.accounts.profile(customer.id);
  }

  @Patch()
  @CustomerRoute()
  @RateLimit({ limit: 20, perSeconds: 60 })
  @SerializeOptions({ schema: customerProfileSchema })
  @ApiOkResponse({ description: 'The updated profile', standardSchema: customerProfileSchema })
  update(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: updateCustomerProfileSchema })
    body: z.output<typeof updateCustomerProfileSchema>,
    @Req() request: Request,
  ) {
    return this.accounts.updateProfile(customer.id, body, requestMeta(request));
  }
}
