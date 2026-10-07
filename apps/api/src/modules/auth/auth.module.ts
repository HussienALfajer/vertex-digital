import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/index.js';
import { AuthAdminController } from './auth.admin.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthAccountController } from './auth-account.controller.js';
import { AuthAccountService } from './auth-account.service.js';
import { AuthTestCustomersService } from './auth-test-customers.service.js';

/**
 * Customer identity (ADR 0007, S01): the customer Better Auth instance at `/api/auth` and its
 * tables, the account changes, the profile and the admin's test customers.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [AuthController, AuthAccountController, AuthAdminController],
  providers: [AuthService, AuthAccountService, AuthTestCustomersService],
  exports: [AuthService],
})
export class AuthModule {}
