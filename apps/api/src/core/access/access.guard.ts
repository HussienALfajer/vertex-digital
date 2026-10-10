import type { IncomingHttpHeaders } from 'node:http';
import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BACKGROUND_REQUEST_HEADER } from '@vertex-digital/contracts';
import { AdminAuthService } from '../../modules/admin/index.js';
import { AuthService, type CustomerIdentity } from '../../modules/auth/index.js';
import { CodedException } from '../errors/index.js';
import {
  ACCESS,
  isRecentlyReauthenticated,
  type RouteAccess,
  SENSITIVE,
} from './access.decorators.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';

type GuardedRequest = AuthenticatedRequest & { headers: IncomingHttpHeaders };

/**
 * Enforces `@Public()`, `@CustomerRoute()`, `@AdminRoute()` and `@AdminSetupRoute()` on every
 * route (ADR 0007, 0011, 0016). Customer routes read only the customer session cookie and admin
 * routes only the admin one, so a session of one kind never opens a route of the other. A route
 * without a declaration is refused.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly customers: AuthService,
    private readonly admins: AdminAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ACCESS, targets);
    const request = context.switchToHttp().getRequest<GuardedRequest>();

    switch (access?.kind) {
      case 'public':
        return true;
      case 'customer': {
        const customer = await this.customerOf(request.headers);
        request.customer = customer;
        // For long requests (the notification stream, S05 rule NT6): the same checks again.
        request.customerSessionValid = () =>
          this.customerOf(request.headers).then(
            (again) => again.id === customer.id && again.sessionId === customer.sessionId,
            () => false,
          );
        return true;
      }
      case 'admin':
      case 'adminSetup': {
        // Requests the panel makes on its own (polling) do not count as activity (rule D4).
        const background = request.headers[BACKGROUND_REQUEST_HEADER] === '1';
        const admin = await this.admins.adminOf(request.headers, { activity: !background });
        if (!admin || admin.archived) {
          throw new CodedException(401, 'UNAUTHORIZED', 'Sign in first');
        }
        if (access.kind === 'admin') {
          if (admin.mustChangePassword) {
            throw new CodedException(403, 'PASSWORD_CHANGE_REQUIRED', 'Change the password first');
          }
          if (!admin.twoFactorEnabled) {
            throw new CodedException(403, 'TWO_FACTOR_REQUIRED', 'Set up two-factor sign-in first');
          }
          const sensitive = this.reflector.getAllAndOverride<boolean>(SENSITIVE, targets);
          if (sensitive && !isRecentlyReauthenticated(admin)) {
            throw new CodedException(
              403,
              'REAUTHENTICATION_REQUIRED',
              'Confirm your password and code first',
            );
          }
        }
        request.admin = admin;
        // For long requests (the admin stream, S11 rule LR4): the session still open, not idle,
        // checked without counting as activity.
        request.adminSessionValid = () =>
          this.admins.adminOf(request.headers, { activity: false }).then(
            (again) => again !== null && !again.archived && again.sessionId === admin.sessionId,
            () => false,
          );
        return true;
      }
      default:
        this.logger.error(`Route without an access declaration: ${context.getClass().name}`);
        throw new CodedException(403, 'FORBIDDEN', 'Route access is not declared');
    }
  }

  private async customerOf(headers: IncomingHttpHeaders): Promise<CustomerIdentity> {
    const customer = await this.customers.customerOf(headers);
    if (!customer || customer.archived) {
      throw new CodedException(401, 'UNAUTHORIZED', 'Sign in first');
    }
    if (!customer.emailVerified) {
      throw new CodedException(403, 'EMAIL_NOT_VERIFIED', 'Verify your email first');
    }
    return customer;
  }
}
