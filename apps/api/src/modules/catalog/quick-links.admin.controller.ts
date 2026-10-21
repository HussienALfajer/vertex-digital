import { Controller, Get, Header, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type QuickLinkStatsQuery,
  quickLinkStatsQuerySchema,
  quickLinkStatsSchema,
} from '@vertex-digital/contracts';
import { AdminRoute } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { QuickLinksService } from './quick-links.service.js';

/** The direct links' counts in the panel (S22 DL5). Never cached. */
@ApiTags('catalog')
@Controller('admin/quick-links')
export class QuickLinksAdminController {
  constructor(private readonly quickLinks: QuickLinksService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(quickLinkStatsQuerySchema)
  @SerializeOptions({ schema: quickLinkStatsSchema })
  @ApiOkResponse({ description: 'Opens and orders per link', standardSchema: quickLinkStatsSchema })
  stats(@Query({ schema: quickLinkStatsQuerySchema }) query: QuickLinkStatsQuery) {
    return this.quickLinks.stats(query);
  }
}
