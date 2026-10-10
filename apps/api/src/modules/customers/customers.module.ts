import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuditModule } from '../audit/index.js';
import { AuthModule } from '../auth/index.js';
import { DepositsModule } from '../deposits/index.js';
import { CustomersAdminController } from './customers.admin.controller.js';
import { CustomersService } from './customers.service.js';

/**
 * Customer administration (S12 F19): `customer_limits` and `customer_notes`. The customer rows
 * stay the `auth` module's; the profile reads and the state changes go through
 * `packages/db/src/customers`. Above `audit` (the history tab) and `deposits` (the limit tiers).
 */
@Module({
  imports: [AuthModule, AdminModule, AuditModule, DepositsModule],
  controllers: [CustomersAdminController],
  providers: [CustomersService],
})
export class CustomersModule {}
