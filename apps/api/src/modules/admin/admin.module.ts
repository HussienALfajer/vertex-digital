import { Module } from '@nestjs/common';
import { AdminAccountController } from './admin-account.controller.js';
import { AdminAccountService } from './admin-account.service.js';
import { AdminAuthService } from './admin-auth.service.js';

/**
 * The one admin account (ADR 0007, 0016): the admin Better Auth instance at `/api/admin/auth`,
 * with mandatory TOTP, short sessions and ALTCHA after repeated failures, and the admin's own
 * password, re-authentication and sessions.
 */
@Module({
  controllers: [AdminAccountController],
  providers: [AdminAuthService, AdminAccountService],
  exports: [AdminAuthService],
})
export class AdminModule {}
