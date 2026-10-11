import { Module } from '@nestjs/common';
import { ReportsAdminController } from './reports.admin.controller.js';
import { ReportsService } from './reports.service.js';

/** Reports (S13, F22): no tables of its own; reads through `packages/db/src/reports`. */
@Module({
  controllers: [ReportsAdminController],
  providers: [ReportsService],
})
export class ReportsModule {}
