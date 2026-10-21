import { Controller, Get, Header, Param, Query, Req, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type QuickLinkQuery,
  quickLinkQuerySchema,
  quickLinkResolveSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { Public } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { QuickLinksService } from './quick-links.service.js';

/**
 * A direct buy link's target (S22 DL2), read by the store's `/q/<code>` route with the visitor's
 * address: no cookie read or set, 60 a minute per address (and nginx's zone), never cached (each
 * read may count an open), never indexed.
 */
@ApiTags('catalog')
@Controller('q')
@RateLimit({ limit: 60, perSeconds: 60 })
export class QuickLinksController {
  constructor(private readonly quickLinks: QuickLinksService) {}

  @Get(':code')
  @Public()
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex')
  @ApiQueryOf(quickLinkQuerySchema)
  @SerializeOptions({ schema: quickLinkResolveSchema })
  @ApiOkResponse({ description: 'Where the link leads', standardSchema: quickLinkResolveSchema })
  resolve(
    @Param('code') code: string,
    @Query({ schema: quickLinkQuerySchema }) query: QuickLinkQuery,
    @Req() request: Request,
  ) {
    return this.quickLinks.resolve(code, query.c, requestMeta(request).ipAddress);
  }
}
