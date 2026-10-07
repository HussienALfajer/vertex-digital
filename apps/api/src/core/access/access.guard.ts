import type { IncomingHttpHeaders } from 'node:http';
import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_SESSION_RULES, BACKGROUND_REQUEST_HEADER } from '@vertex-digital/contracts';
import { AdminAuthService } from '../../modules/admin/index.js';
import { AuthService } from '../../modules/auth/index.js';
import { CodedException } from '../errors/index.js';
import { ACCESS, type RouteAccess, SENSITIVE } from './access.decorators.js';
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
        const customer = await this.customers.customerOf(request.headers);
        if (!customer || customer.archived) {
          throw new CodedException(401, 'UNAUTHORIZED', 'Sign in first');
        }
        if (!customer.emailVerified) {
          throw new CodedException(403, 'EMAIL_NOT_VERIFIED', 'Verify your email first');
        }
        request.customer = customer;
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
          const fresh =
            admin.reauthenticatedAt !== null &&
            Date.now() - admin.reauthenticatedAt.getTime() <=
              ADMIN_SESSION_RULES.reauthenticationMs;
          if (sensitive && !fresh) {
            throw new CodedException(
              403,
              'REAUTHENTICATION_REQUIRED',
              'Confirm your password and code first',
            );
          }
        }
        request.admin = admin;
        return true;
      }
      default:
        this.logger.error(`Route without an access declaration: ${context.getClass().name}`);
        throw new CodedException(403, 'FORBIDDEN', 'Route access is not declared');
    }
  }
}
