import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { RatesModule } from '../rates/index.js';
import { TreasuryAdminController } from './treasury.admin.controller.js';
import { TreasuryService } from './treasury.service.js';

/**
 * Treasury (S13, ADR 0027): `treasury_movements`. The money places, transfers between them and
 * the outside, supplier corrections and reversals, each with its `treasury` journal.
 */
@Module({
  imports: [AdminModule, RatesModule],
  controllers: [TreasuryAdminController],
  providers: [TreasuryService],
})
export class TreasuryModule {}
