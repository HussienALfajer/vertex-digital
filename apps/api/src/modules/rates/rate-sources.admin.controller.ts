import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type CreateRateSource,
  createRateSourceSchema,
  rateSourceListSchema,
  rateSourceSchema,
  rateSourceTestResultSchema,
  type TestRateSource,
  testRateSourceSchema,
  type UpdateRateSource,
  updateRateSourceSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import type { AdminIdentity } from '../admin/index.js';
import { RateSourcesService } from './rate-sources.service.js';

/** S27 rate sources: list, add, edit, archive (writes re-authenticated) and a test read. */
@ApiTags('rates')
@Controller('admin/rate-sources')
export class RateSourcesAdminController {
  constructor(private readonly sources: RateSourcesService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSourceListSchema })
  @ApiOkResponse({
    description: 'Live sources with their last three reads',
    standardSchema: rateSourceListSchema,
  })
  list() {
    return this.sources.list();
  }

  @Post()
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSourceSchema })
  @ApiCreatedResponse({ description: 'The new source', standardSchema: rateSourceSchema })
  create(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: createRateSourceSchema }) body: CreateRateSource,
    @Req() request: Request,
  ) {
    return this.sources.create(admin.id, body, requestMeta(request));
  }

  /** Reads a page once and stores nothing (edge case 10): 10 per minute. */
  @Post('test')
  @AdminRoute()
  @HttpCode(200)
  @RateLimit({ limit: 10, perSeconds: 60 })
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSourceTestResultSchema })
  @ApiOkResponse({ description: 'What the read found', standardSchema: rateSourceTestResultSchema })
  test(@Body({ schema: testRateSourceSchema }) body: TestRateSource) {
    return this.sources.test(body);
  }

  @Patch(':id')
  @AdminRoute()
  @Sensitive()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSourceSchema })
  @ApiOkResponse({ description: 'The source', standardSchema: rateSourceSchema })
  update(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body({ schema: updateRateSourceSchema }) body: UpdateRateSource,
    @Req() request: Request,
  ) {
    return this.sources.update(admin.id, id, body, requestMeta(request));
  }

  @Post(':id/archive')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: rateSourceSchema })
  @ApiOkResponse({ description: 'The archived source', standardSchema: rateSourceSchema })
  archive(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    return this.sources.archive(admin.id, id, requestMeta(request));
  }
}
