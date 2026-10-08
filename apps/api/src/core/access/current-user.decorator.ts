import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AdminIdentity } from '../../modules/admin/index.js';
import type { CustomerIdentity } from '../../modules/auth/index.js';

/** What `AccessGuard` attaches to the request once it lets it through. */
export interface AuthenticatedRequest {
  customer?: CustomerIdentity;
  /** On customer routes: whether the request's session still passes the guard's checks. */
  customerSessionValid?: () => Promise<boolean>;
  admin?: AdminIdentity;
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

/** The signed-in admin of an `@AdminRoute()`. */
export const CurrentAdmin = createParamDecorator(
  (_: unknown, context: ExecutionContext): AdminIdentity => attached('admin', context),
);

/** On a `@CustomerRoute()`: re-runs the guard's checks on the request's session (S05 rule NT6). */
export const CustomerSessionCheck = createParamDecorator(
  (_: unknown, context: ExecutionContext): (() => Promise<boolean>) =>
    attached('customerSessionValid', context),
);
