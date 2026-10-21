import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type MerchantLevelInput,
  merchantLevelInputSchema,
  merchantLevelListSchema,
  merchantLevelSchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { MerchantLevelsService } from './merchant-levels.service.js';

/** Volume levels in the panel (S21 F39): every change re-authenticates (Access). */
@ApiTags('merchants')
@Controller('admin/merchant-levels')
export class MerchantLevelsAdminController {
  constructor(private readonly levels: MerchantLevelsService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: merchantLevelListSchema })
  @ApiOkResponse({
    description: 'The levels with their merchants',
    standardSchema: merchantLevelListSchema,
  })
  list() {
    return this.levels.list();
  }

  @Post()
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: merchantLevelSchema })
  @ApiCreatedResponse({ description: 'The new level', standardSchema: merchantLevelSchema })
  create(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: merchantLevelInputSchema }) body: MerchantLevelInput,
    @Req() request: Request,
  ) {
    return this.levels.create(body, { adminId: admin.id, meta: requestMeta(request) });
  }

  @Patch(':id')
  @AdminRoute()
  @Sensitive()
  @SerializeOptions({ schema: merchantLevelSchema })
  @ApiOkResponse({ description: 'The level', standardSchema: merchantLevelSchema })
  update(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id') id: string,
    @Body({ schema: merchantLevelInputSchema }) body: MerchantLevelInput,
    @Req() request: Request,
  ) {
    return this.levels.update(id, body, { adminId: admin.id, meta: requestMeta(request) });
  }

  @Post(':id/archive')
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @SerializeOptions({ schema: merchantLevelSchema })
  @ApiOkResponse({ description: 'The archived level', standardSchema: merchantLevelSchema })
  archive(@CurrentAdmin() admin: AdminIdentity, @Param('id') id: string, @Req() request: Request) {
    return this.levels.archive(id, { adminId: admin.id, meta: requestMeta(request) });
  }
}
