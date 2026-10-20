import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  SerializeOptions,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { gamePlayerCheckStateSchema, updateGamePlayerCheckSchema } from '@vertex-digital/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import { requestMeta } from '../../core/http/request-meta.js';
import { StoreRevalidateInterceptor } from '../../core/jobs/index.js';
import type { AdminIdentity } from '../admin/index.js';
import { GamePlayerChecksService } from './game-player-checks.service.js';

/**
 * S19 PC1: a game's player-check provider, on the game's page. The store shows which packs can
 * check a player id, so a change refreshes it.
 */
@ApiTags('orders')
@Controller('admin/catalog/games/:id/player-check')
@UseInterceptors(StoreRevalidateInterceptor)
export class GamePlayerChecksAdminController {
  constructor(private readonly checks: GamePlayerChecksService) {}

  @Get()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gamePlayerCheckStateSchema })
  @ApiOkResponse({ description: 'The row, or null', standardSchema: gamePlayerCheckStateSchema })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.checks.get(id);
  }

  @Put()
  @AdminRoute()
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: gamePlayerCheckStateSchema })
  @ApiOkResponse({ description: 'The row as saved', standardSchema: gamePlayerCheckStateSchema })
  set(
    @CurrentAdmin() admin: AdminIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateGamePlayerCheckSchema })
    body: z.output<typeof updateGamePlayerCheckSchema>,
    @Req() request: Request,
  ) {
    return this.checks.set({ adminId: admin.id, meta: requestMeta(request) }, id, body);
  }
}
