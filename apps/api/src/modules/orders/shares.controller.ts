import { Controller, Get, Header, Param, Query, Res, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  publicShareSchema,
  type ShareImageQuery,
  shareImageQuerySchema,
} from '@vertex-digital/contracts';
import type { Response } from 'express';
import { Public } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { ShareLinksService } from './share-links.service.js';

/**
 * The public gift and receipt links (S10 rules SH1, SH2, SH5): no cookie read or set, 60 reads a
 * minute per address, cached briefly so a revocation takes effect within the cache's life.
 */
@ApiTags('orders')
@Controller('shares')
@RateLimit({ limit: 60, perSeconds: 60 })
export class SharesController {
  constructor(private readonly shareLinks: ShareLinksService) {}

  @Get(':token')
  @Public()
  @Header('cache-control', 'public, max-age=30')
  @Header('x-robots-tag', 'noindex')
  @SerializeOptions({ schema: publicShareSchema })
  @ApiOkResponse({ description: 'What the owner chose to show', standardSchema: publicShareSchema })
  share(@Param('token') token: string) {
    return this.shareLinks.publicShare(token);
  }

  @Get(':token/image')
  @Public()
  @ApiProduces('image/png')
  @ApiQueryOf(shareImageQuerySchema)
  @ApiOkResponse({ description: '1200 × 630 (`og`) or 1080 × 1080 (`square`), PNG' })
  async image(
    @Param('token') token: string,
    @Query({ schema: shareImageQuerySchema }) query: ShareImageQuery,
    @Res() response: Response,
  ) {
    const png = await this.shareLinks.image(token, query.format);
    response
      .status(200)
      .set({
        'content-type': 'image/png',
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
      })
      .send(png);
  }
}
