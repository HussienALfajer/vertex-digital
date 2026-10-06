import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CustomerIdentity } from '../../modules/auth/index.js';
import type { StaffIdentity } from '../../modules/staff/index.js';

/** What `AccessGuard` attaches to the request once it lets it through. */
export interface AuthenticatedRequest {
  customer?: CustomerIdentity;
  staff?: StaffIdentity;
}

function attached<T>(key: keyof AuthenticatedRequest, context: ExecutionContext): T {
  const value = context.switchToHttp().getRequest<AuthenticatedRequest>()[key];
  // The guard sets it on every route of the matching kind: a miss is a wrong decorator pairing.
  if (!value) throw new Error(`No ${key} on this request: is the route declared for it?`);
  return value as T;
}

/** The signed-in customer of a `@CustomerRoute()`. */
export const CurrentCustomer = createParamDecorator(
  (_: unknown, context: ExecutionContext): CustomerIdentity => attached('customer', context),
);

/** The signed-in staff member of a `@StaffRoute()`. */
export const CurrentStaff = createParamDecorator(
  (_: unknown, context: ExecutionContext): StaffIdentity => attached('staff', context),
);
