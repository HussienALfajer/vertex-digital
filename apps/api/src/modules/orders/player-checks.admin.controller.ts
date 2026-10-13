import { Body, Controller, Header, HttpCode, Post, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type AdminPlayerCheck,
  adminPlayerCheckSchema,
  playerCheckSchema,
} from '@vertex-digital/contracts';
import { AdminRoute, CurrentAdmin } from '../../core/access/index.js';
import type { AdminIdentity } from '../admin/index.js';
import { PlayerChecksService } from './player-checks.service.js';

/** S16 rule AP8: the purchase dialog's player check, with the admin as requester. */
@ApiTags('orders')
@Controller('admin/player-checks')
export class PlayerChecksAdminController {
  constructor(private readonly playerChecks: PlayerChecksService) {}

  @Post()
  @AdminRoute()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @SerializeOptions({ schema: playerCheckSchema })
  @ApiOkResponse({
    description: 'The check, from the cache or a supplier',
    standardSchema: playerCheckSchema,
  })
  check(
    @CurrentAdmin() admin: AdminIdentity,
    @Body({ schema: adminPlayerCheckSchema }) body: AdminPlayerCheck,
  ) {
    return this.playerChecks.checkForAdmin(admin.id, body);
  }
}
