import { Controller, Get, Header, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { storeStatusSchema } from '@vertex-digital/contracts';
import { Public } from '../../core/access/index.js';
import { RateLimit } from '../../core/rate-limit/rate-limit.js';
import { SettingsService } from './settings.service.js';

/** `GET /api/store/status` (S05 rules SW8, SW9): what every visitor may know. */
@ApiTags('settings')
@Controller('store')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('status')
  @Public()
  // Read by the store banner on every page: room for many customers behind one carrier address.
  @RateLimit({ limit: 300, perSeconds: 60 })
  @Header('cache-control', 'public, max-age=10')
  @SerializeOptions({ schema: storeStatusSchema })
  @ApiOkResponse({
    description: 'Registration and the emergency stop',
    standardSchema: storeStatusSchema,
  })
  status() {
    return this.settings.status();
  }
}
