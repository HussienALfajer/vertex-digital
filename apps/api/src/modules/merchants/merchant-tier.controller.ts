import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  merchantCertificateSchema,
  merchantTierHistorySchema,
  merchantTierSummarySchema,
  merchantTierTableSchema,
  publicCertificateSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { CurrentCustomer, CustomerRoute, Public } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { MerchantTierService } from './merchant-tier.service.js';

/**
 * The merchant's tier and certificate (S23 ID3, ID4, ID7, PG1–PG7): merchants only, never
 * cached; and the certificate's public page, which reads no cookie, 60 lookups a minute per
 * address (and nginx's zone), cached 30 s, never indexed.
 */
@ApiTags('merchants')
@Controller()
export class MerchantTierController {
  constructor(private readonly tiers: MerchantTierService) {}

  @Get('merchant/tier')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantTierSummarySchema })
  @ApiOkResponse({
    description: 'The tier card (ID3, PG1, PG4, PG6)',
    standardSchema: merchantTierSummarySchema,
  })
  summary(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tiers.summary(customer.id);
  }

  @Get('merchant/tier/table')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantTierTableSchema })
  @ApiOkResponse({ description: 'The tier table (PG2)', standardSchema: merchantTierTableSchema })
  table(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tiers.table(customer.id);
  }

  @Get('merchant/tier/history')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantTierHistorySchema })
  @ApiOkResponse({
    description: 'The months held (PG5)',
    standardSchema: merchantTierHistorySchema,
  })
  history(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tiers.history(customer.id);
  }

  @Post('merchant/tier/celebrated')
  @CustomerRoute()
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'The celebration was seen (ID4)' })
  async celebrated(@CurrentCustomer() customer: CustomerIdentity) {
    await this.tiers.celebrated(customer.id);
  }

  @Get('merchant/certificate')
  @CustomerRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantCertificateSchema })
  @ApiOkResponse({
    description: 'The certificate (ID7)',
    standardSchema: merchantCertificateSchema,
  })
  certificate(@CurrentCustomer() customer: CustomerIdentity) {
    return this.tiers.certificate(customer.id);
  }

  @Post('merchant/certificate/reissue')
  @CustomerRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantCertificateSchema })
  @ApiOkResponse({
    description: 'A new code; old prints stop resolving (ID7)',
    standardSchema: merchantCertificateSchema,
  })
  reissue(@CurrentCustomer() customer: CustomerIdentity, @Req() request: Request) {
    return this.tiers.reissue(customer.id, requestMeta(request));
  }

  @Get('certificates/:code')
  @Public()
  @RateLimit({ limit: 60, perSeconds: 60 })
  @Header('cache-control', 'public, max-age=30')
  @Header('x-robots-tag', 'noindex')
  @SerializeOptions({ schema: publicCertificateSchema })
  @ApiOkResponse({
    description: 'The trade name, place and current tier only (ID7)',
    standardSchema: publicCertificateSchema,
  })
  publicCertificate(@Param('code') code: string) {
    return this.tiers.publicCertificate(code);
  }
}
