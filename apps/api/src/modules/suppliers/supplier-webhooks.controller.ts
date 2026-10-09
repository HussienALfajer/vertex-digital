import { Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../core/access/index.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { SupplierWebhooksService } from './supplier-webhooks.service.js';

/**
 * `POST /api/webhooks/suppliers/:code` (S08 rule F4): a supplier's signed order result. 200 with
 * no body once stored (a replay too), 401 for a bad signature or time, 404 for a supplier
 * without webhooks here. The raw body is read by `supplierWebhookBody` (64 KB). Not in the
 * OpenAPI document: no client calls it.
 */
@ApiExcludeController()
@Controller('webhooks/suppliers')
export class SupplierWebhooksController {
  constructor(private readonly webhooks: SupplierWebhooksService) {}

  @Post(':code')
  @Public()
  @HttpCode(200)
  @RateLimit({ limit: 120, perSeconds: 60 })
  async receive(
    @Param('code') code: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value[0] : value,
      ]),
    );
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    await this.webhooks.receive(code, headers, body);
    response.status(200).end();
  }
}
