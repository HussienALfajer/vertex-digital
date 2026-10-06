import { Module } from '@nestjs/common';
import { StaffAuthService } from './staff-auth.service.js';

/**
 * Staff identity and roles (ADR 0007): the staff Better Auth instance at `/api/admin/auth`, with
 * mandatory TOTP and ALTCHA after repeated failures. Staff management in the panel arrives with F02.
 */
@Module({
  providers: [StaffAuthService],
  exports: [StaffAuthService],
})
export class StaffModule {}
