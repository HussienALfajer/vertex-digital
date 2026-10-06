import { z } from 'zod';

/*
 * Staff roles and the permission map (ADR 0007), owned by the api `staff` module. The API guard
 * checks `@StaffRoute(permission…)` against this map; services apply any record scope as query
 * filters. Each feature adds the permissions it needs and grants them to roles here.
 */

export const STAFF_ROLES = [
  'owner',
  'manager',
  'order_operator',
  'deposit_reviewer',
  'support',
] as const;

export const staffRoleSchema = z.enum(STAFF_ROLES).meta({ id: 'StaffRole' });

export type StaffRole = z.infer<typeof staffRoleSchema>;

export const PERMISSIONS = [
  /** Create, change and archive staff accounts and their roles (F02). */
  'staff.manage',
] as const;

export const permissionSchema = z.enum(PERMISSIONS).meta({ id: 'Permission' });

export type Permission = z.infer<typeof permissionSchema>;

/** What each role may do. The owner holds every permission. */
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  owner: PERMISSIONS,
  manager: [],
  order_operator: [],
  deposit_reviewer: [],
  support: [],
};

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
