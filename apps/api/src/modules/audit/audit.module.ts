import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/index.js';
import { AuthModule } from '../auth/index.js';
import { AuditAdminController } from './audit.admin.controller.js';
import { AuditService } from './audit.service.js';

/**
 * The audit log screen (S01): reads `audit_entries`. Every module writes its entries itself with
 * `recordAudit` (packages/db), in the transaction of its change.
 */
@Module({
  imports: [AuthModule, AdminModule],
  controllers: [AuditAdminController],
  providers: [AuditService],
})
export class AuditModule {}
