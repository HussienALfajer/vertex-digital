import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { RatesModule } from '../rates/index.js';
import { ReconciliationAdminController } from './reconciliation.admin.controller.js';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * Reconciliation (S13, F20, ADR 0027): the runs, their results and explanations, and the
 * settings. The nightly and manual runs are the worker's; counts are checked here at once.
 */
@Module({
  imports: [AdminModule, RatesModule],
  controllers: [ReconciliationAdminController],
  providers: [ReconciliationService],
})
export class ReconciliationModule {}
