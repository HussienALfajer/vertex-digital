import type { IncomingHttpHeaders } from 'node:http';
import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission } from '@vertex-digital/contracts';
import { AuthService } from '../../modules/auth/index.js';
import { StaffAuthService } from '../../modules/staff/index.js';
import { CodedException } from '../errors/index.js';
import { ACCESS, type RouteAccess } from './access.decorators.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';

type GuardedRequest = AuthenticatedRequest & { headers: IncomingHttpHeaders };

/**
 * Enforces `@Public()`, `@CustomerRoute()` and `@StaffRoute()` on every route (ADR 0007, 0011).
 * Customer routes read only the customer session cookie and staff routes only the staff one, so a
 * session of one kind never opens a route of the other. A route without a declaration is refused.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly customers: AuthService,
    private readonly staff: StaffAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
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
      case 'staff': {
        const member = await this.staff.staffOf(request.headers);
        if (!member || member.archived) {
          throw new CodedException(401, 'UNAUTHORIZED', 'Sign in first');
        }
        if (!member.twoFactorEnabled) {
          throw new CodedException(403, 'TWO_FACTOR_REQUIRED', 'Set up two-factor sign-in first');
        }
        if (!access.permissions.every((permission) => hasPermission(member.role, permission))) {
          throw new CodedException(403, 'FORBIDDEN', 'Your role does not allow this');
        }
        request.staff = member;
        return true;
      }
      default:
        this.logger.error(`Route without an access declaration: ${context.getClass().name}`);
        throw new CodedException(403, 'FORBIDDEN', 'Route access is not declared');
    }
  }
}
