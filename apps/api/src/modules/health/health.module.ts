import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/** `GET /api/health` for nginx, PM2 and the deploy checks. Owns no table. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
