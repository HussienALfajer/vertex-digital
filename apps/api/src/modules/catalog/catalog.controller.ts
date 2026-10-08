import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../core/access/index.js';
import { sendImage } from '../files/index.js';
import { CatalogService } from './catalog.service.js';

/** Public catalog routes (S06): the catalog images. S09 adds the store's catalog reads. */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** Rule CT10: catalog images only; ids are UUIDs, never cached as anything but immutable. */
  @Get('images/:id')
  @Public()
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'A catalog image (WebP)' })
  async image(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    return sendImage(response, await this.catalog.image(id), 'public, max-age=31536000, immutable');
  }
}
