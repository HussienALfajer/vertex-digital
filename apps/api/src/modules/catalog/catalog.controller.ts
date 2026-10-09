import { Controller, Get, Header, Param, Query, Res, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type CatalogImageQuery,
  catalogImageQuerySchema,
  searchIndexSchema,
  storefrontSchema,
  storeGameSchema,
} from '@vertex-digital/contracts';
import type { Response } from 'express';
import { Public } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { sendImage } from '../files/index.js';
import { CatalogStoreService } from './catalog-store.service.js';

/** What a public catalog answer may be cached for (S09 "API"): the store revalidates on change. */
const PUBLIC_CACHE = 'public, max-age=30';

/**
 * Public catalog routes: the catalog images (S06) and the store's catalog reads (S09). They read
 * no cookie and hold no customer data, so any cache may keep them.
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly store: CatalogStoreService) {}

  /** Rules SF1, SS2: the home page's categories and games with their status. */
  @Get('storefront')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @SerializeOptions({ schema: storefrontSchema })
  @ApiOkResponse({ description: 'The storefront', standardSchema: storefrontSchema })
  storefront() {
    return this.store.storefront();
  }

  /** Rules SF1–SF3: a shown game with its fields and packs. */
  @Get('games/:slug')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @SerializeOptions({ schema: storeGameSchema })
  @ApiOkResponse({ description: 'A game page', standardSchema: storeGameSchema })
  game(@Param('slug') slug: string) {
    return this.store.game(slug);
  }

  /** Rule SR2: every shown game and its packs, for the search dialog. */
  @Get('search-index')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @SerializeOptions({ schema: searchIndexSchema })
  @ApiOkResponse({ description: 'The search index', standardSchema: searchIndexSchema })
  searchIndex() {
    return this.store.searchIndex();
  }

  /**
   * Rule CT10: catalog images only, never cached as anything but immutable. S09 rule SF5: `w` is
   * one of the store widths, the image fitted to it, never upscaled.
   */
  @Get('images/:id')
  @Public()
  @ApiProduces('image/webp')
  @ApiQueryOf(catalogImageQuerySchema)
  @ApiOkResponse({ description: 'A catalog image (WebP)' })
  async image(
    @Param('id') id: string,
    @Query({ schema: catalogImageQuerySchema }) query: CatalogImageQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendImage(
      response,
      await this.store.image(id, query.w),
      'public, max-age=31536000, immutable',
    );
  }
}
