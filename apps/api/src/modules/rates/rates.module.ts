import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { RatesAdminController } from './rates.admin.controller.js';
import { RatesService } from './rates.service.js';

/**
 * Exchange rates (S03, F04): `exchange_rates`. The admin's rate and display step with their
 * history; other modules read the rate in force through `RatesService.current()`.
 */
@Module({
  imports: [AdminModule],
  controllers: [RatesAdminController],
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}
