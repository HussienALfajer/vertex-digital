import { Controller, Get, Res, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { type HealthResponse, healthResponseSchema } from '@vertex-digital/contracts';
import type { Response } from 'express';
import { Public } from '../../core/access/index.js';
import { HealthService } from './health.service.js';

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Public()
  @SerializeOptions({ schema: healthResponseSchema })
  @ApiOkResponse({
    description: 'The API and its dependencies are up',
    standardSchema: healthResponseSchema,
  })
  @ApiServiceUnavailableResponse({
    description: 'A dependency is down',
    standardSchema: healthResponseSchema,
  })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') response.status(503);
    return result;
  }
}
