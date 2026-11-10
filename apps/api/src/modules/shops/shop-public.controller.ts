import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  shopGameSchema,
  shopIconQuerySchema,
  shopManifestSchema,
  shopMovedSchema,
  shopStorefrontSchema,
} from '@vertex-digital/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Public } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { sendImage } from '../files/index.js';
import { ShopMoved, ShopStorefrontService } from './shop-storefront.service.js';

/** S26: what a shop's public answer may be cached for; the store revalidates `shop:<id>`. */
const PUBLIC_CACHE = 'public, max-age=30';

/**
 * The three JSON reads parse their answer themselves (no `SerializeOptions`): an old slug answers
 * another shape (`ShopMoved`).
 *
 * A shop's public pages (S26 PR1–PR4, SP1, SP3, SP4): the home, a game, the logo, the icons, the
 * manifest's data and the visit counter. They read no cookie and carry only the merchant's public
 * selling prices, so any cache may keep them. An old slug answers `301` with the current one
 * (SH3); a shop that is requested or rejected, or no shop, is `404`. `noindex` on every answer.
 */
@ApiTags('shops')
@Controller('shops/:slug')
export class ShopPublicController {
  constructor(private readonly storefront: ShopStorefrontService) {}

  @Get()
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @Header('x-robots-tag', 'noindex')
  @ApiOkResponse({ description: 'The shop’s home (PR1)', standardSchema: shopStorefrontSchema })
  async home(@Param('slug') slug: string, @Res({ passthrough: true }) response: Response) {
    return this.moved(response, async () =>
      shopStorefrontSchema.parse(await this.storefront.storefront(slug)),
    );
  }

  @Get('games/:game')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @Header('x-robots-tag', 'noindex')
  @ApiOkResponse({ description: 'A game at the selling prices', standardSchema: shopGameSchema })
  async game(
    @Param('slug') slug: string,
    @Param('game') game: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.moved(response, async () =>
      shopGameSchema.parse(await this.storefront.game(slug, game)),
    );
  }

  @Get('manifest')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @ApiOkResponse({
    description: 'The web manifest’s data (SP1)',
    standardSchema: shopManifestSchema,
  })
  async manifest(@Param('slug') slug: string, @Res({ passthrough: true }) response: Response) {
    return this.moved(response, async () =>
      shopManifestSchema.parse(await this.storefront.manifest(slug)),
    );
  }

  @Get('logo')
  @Public()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'The merchant’s logo (ST2)' })
  async logo(@Param('slug') slug: string, @Res({ passthrough: true }) response: Response) {
    return sendImage(response, await this.storefront.logo(slug), 'public, max-age=300');
  }

  @Get('icon')
  @Public()
  @ApiProduces('image/png')
  @ApiQueryOf(shopIconQuerySchema)
  @ApiOkResponse({ description: 'The app icon (SP1)' })
  async icon(
    @Param('slug') slug: string,
    @Query({ schema: shopIconQuerySchema }) query: z.output<typeof shopIconQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const png = await this.storefront.icon(slug, query.size);
    response.setHeader('cache-control', 'public, max-age=3600');
    response.setHeader('content-type', 'image/png');
    response.setHeader('x-content-type-options', 'nosniff');
    return new StreamableFile(png);
  }

  /** SP3: one page view; bots, crawlers and link previews are not counted. */
  @Post('visits')
  @Public()
  @RateLimit({ limit: 60, perSeconds: 60 })
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Counted, or left out as a bot' })
  async visit(@Param('slug') slug: string, @Req() request: Request) {
    await this.storefront.countVisit(slug, requestMeta(request).userAgent);
  }

  /** SH3: an old slug's `301`, with the current slug in the body for the store's redirect. */
  private async moved<T>(response: Response, read: () => Promise<T>) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof ShopMoved)) throw error;
      response.status(301);
      response.setHeader('location', `/api/shops/${error.slug}`);
      return shopMovedSchema.parse({ slug: error.slug });
    }
  }
}
