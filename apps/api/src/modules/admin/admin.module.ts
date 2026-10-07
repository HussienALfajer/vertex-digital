import { Module } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service.js';

/**
 * The one admin account (ADR 0007, 0016): the admin Better Auth instance at `/api/admin/auth`,
 * with mandatory TOTP and ALTCHA after repeated failures.
 */
@Module({
  providers: [AdminAuthService],
  exports: [AdminAuthService],
})
export class AdminModule {}
