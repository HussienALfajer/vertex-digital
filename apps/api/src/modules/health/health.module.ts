import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * `GET /api/health` for nginx, PM2 and the deploy checks, and the worker's heartbeats for the
 * dashboard (`HealthService.lastWorkerBeat`). Owns `worker_heartbeats` (written by the worker).
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
