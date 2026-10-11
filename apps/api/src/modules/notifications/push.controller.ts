import { Body, Controller, Delete, Get, Header, HttpCode, Put } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type PushSubscription,
  pushConfigSchema,
  pushSubscriptionSchema,
  type RemovePushSubscription,
  removePushSubscriptionSchema,
} from '@vertex-digital/contracts';
import { CurrentCustomer, CustomerRoute, Public } from '../../core/access/index.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { CustomerIdentity } from '../auth/index.js';
import { PushService } from './push.service.js';

/**
 * Web push (S15): the public key, and this device's subscription for the signed-in customer,
 * frozen customers included (rule PC5).
 */
@ApiTags('notifications')
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('config')
  @Public()
  @RateLimit({ limit: 60, perSeconds: 60 })
  @Header('cache-control', 'public, max-age=300')
  @ApiOkResponse({
    description: 'The VAPID public key, or null when push is not configured',
    standardSchema: pushConfigSchema,
  })
  config() {
    return this.push.config();
  }

  /** Rules PS1–PS3. */
  @Put('subscription')
  @CustomerRoute()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'This device receives pushes for this session' })
  async register(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: pushSubscriptionSchema }) body: PushSubscription,
  ) {
    await this.push.register(customer, body);
  }

  /** Rule PS8: 204 whether or not a row of this customer matched. */
  @Delete('subscription')
  @CustomerRoute()
  @HttpCode(204)
  @Header('cache-control', 'no-store')
  @ApiNoContentResponse({ description: 'This device no longer receives pushes' })
  async remove(
    @CurrentCustomer() customer: CustomerIdentity,
    @Body({ schema: removePushSubscriptionSchema }) body: RemovePushSubscription,
  ) {
    await this.push.remove(customer.id, body.endpoint);
  }
}
