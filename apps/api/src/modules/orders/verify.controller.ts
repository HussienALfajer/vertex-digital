import { Controller, Get, Header, Param, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { publicVerificationSchema } from '@vertex-digital/contracts';
import { Public } from '../../core/access/index.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { OrderReceiptsService } from './order-receipts.service.js';

/**
 * The public verification page of a receipt's QR (S21 VF2, VF3): no cookie read or set, 60
 * lookups a minute per address (and nginx's zone), cached 30 s, never indexed.
 */
@ApiTags('orders')
@Controller('verify')
@RateLimit({ limit: 60, perSeconds: 60 })
export class VerifyController {
  constructor(private readonly receipts: OrderReceiptsService) {}

  @Get(':code')
  @Public()
  @Header('cache-control', 'public, max-age=30')
  @Header('x-robots-tag', 'noindex')
  @SerializeOptions({ schema: publicVerificationSchema })
  @ApiOkResponse({
    description: 'The order’s facts, never a price, a code or the customer',
    standardSchema: publicVerificationSchema,
  })
  verify(@Param('code') code: string) {
    return this.receipts.verify(code);
  }
}
