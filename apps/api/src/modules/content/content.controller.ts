import { Controller, Get, Header, Param, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type ActivityQuery,
  activityQuerySchema,
  activitySchema,
  type ContentPage,
  publishedFaqSchema,
  publishedPageSchema,
  siteContentSchema,
} from '@vertex-digital/contracts';
import { Public } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { ContentActivityService } from './content-activity.service.js';
import { ContentFaqService } from './content-faq.service.js';
import { ContentHomeService } from './content-home.service.js';
import { ContentPagePipe } from './content-page.pipe.js';
import { ContentPagesService } from './content-pages.service.js';

/** Rule CP3: what any cache may keep for a minute; the store's own cache revalidates on change. */
const PUBLIC_CACHE = 'public, max-age=60';

/**
 * The store's content reads (S14 CP2, CP3): only what the store shows, never drafts, archived rows,
 * admin ids or unpublished pages. They read no cookie, so any cache may keep them.
 */
@ApiTags('content')
@Controller('content')
export class ContentController {
  constructor(
    private readonly home: ContentHomeService,
    private readonly pages: ContentPagesService,
    private readonly faq: ContentFaqService,
    private readonly activity: ContentActivityService,
  ) {}

  /** The announcement, live banners, published pages and whether the FAQ is published. */
  @Get('site')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @SerializeOptions({ schema: siteContentSchema })
  @ApiOkResponse({ description: 'The site content', standardSchema: siteContentSchema })
  site() {
    return this.home.site();
  }

  /** Rule PG2: the newest version; an unpublished page is not found. */
  @Get('pages/:page')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @SerializeOptions({ schema: publishedPageSchema })
  @ApiOkResponse({ description: 'A published page', standardSchema: publishedPageSchema })
  page(@Param('page', ContentPagePipe) page: ContentPage) {
    return this.pages.published(page);
  }

  /** Rule FQ5: the newest publication; none, or an empty one, is not found. */
  @Get('faq')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @SerializeOptions({ schema: publishedFaqSchema })
  @ApiOkResponse({ description: 'The published FAQ', standardSchema: publishedFaqSchema })
  publishedFaq() {
    return this.faq.published();
  }

  /** Rules LA1–LA6: store-wide or one game's; an unknown game answers no items. */
  @Get('activity')
  @Public()
  @Header('cache-control', PUBLIC_CACHE)
  @ApiQueryOf(activityQuerySchema)
  @SerializeOptions({ schema: activitySchema })
  @ApiOkResponse({ description: 'The live activity', standardSchema: activitySchema })
  liveActivity(@Query({ schema: activityQuerySchema }) query: ActivityQuery) {
    return this.activity.activity(query.game);
  }
}
