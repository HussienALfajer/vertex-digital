import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  SerializeOptions,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  adminSwitchesSchema,
  type ChangeSwitch,
  changeSwitchSchema,
  type SwitchHistoryQuery,
  switchHistoryPageSchema,
  switchHistoryQuerySchema,
} from '@vertex-digital/contracts';
import type { Request } from 'express';
import { AdminRoute, CurrentAdmin, Sensitive } from '../../core/access/index.js';
import { ApiQueryOf } from '../../core/http/api-query.js';
import { requestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../admin/index.js';
import { SettingsService } from './settings.service.js';

/** The store switches in the panel (S05 F26): read, change with re-authentication, history. */
@ApiTags('settings')
@Controller('admin/switches')
export class SettingsAdminController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminSwitchesSchema })
  @ApiOkResponse({
    description: 'Every switch with its default',
    standardSchema: adminSwitchesSchema,
  })
  list() {
    return this.settings.adminSwitches();
  }

  /** Rules SW2, SW3: both directions need re-authentication in the panel. */
  @Post()
  @AdminRoute()
  @Sensitive()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: adminSwitchesSchema })
  @ApiOkResponse({
    description: 'The switches after the change',
    standardSchema: adminSwitchesSchema,
  })
  change(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: changeSwitchSchema }) body: ChangeSwitch,
    @Req() request: Request,
  ) {
    return this.settings.change(admin.id, body, 'admin', requestMeta(request));
  }

  @Get('history')
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @ApiQueryOf(switchHistoryQuerySchema)
  @SerializeOptions({ schema: switchHistoryPageSchema })
  @ApiOkResponse({ description: 'Newest first', standardSchema: switchHistoryPageSchema })
  history(@Query({ schema: switchHistoryQuerySchema }) query: SwitchHistoryQuery) {
    return this.settings.history(query);
  }
}
