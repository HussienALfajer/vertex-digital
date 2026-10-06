import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';

/**
 * Customer identity (ADR 0007): the customer Better Auth instance at `/api/auth` and its tables.
 * Sign-up, email OTP, phone and profile arrive with F01.
 */
@Module({
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
