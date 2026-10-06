import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Challenge } from 'altcha-lib';
import { Public } from '../access/index.js';
import { RateLimit } from '../rate-limit/rate-limit.js';
import { AltchaService } from './altcha.service.js';

@ApiTags('system')
@Controller('altcha')
export class AltchaController {
  constructor(private readonly altcha: AltchaService) {}

  @Get('challenge')
  @Public()
  @RateLimit({ limit: 30, perSeconds: 60 })
  @Header('cache-control', 'no-store')
  @ApiOkResponse({ description: 'A signed ALTCHA challenge for the widget (ADR 0008)' })
  challenge(): Promise<Challenge> {
    return this.altcha.createChallenge();
  }
}
