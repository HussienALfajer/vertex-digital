import { describe, expect, it } from 'vitest';
import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES } from './staff.js';

describe('permission map', () => {
  it('gives the owner every permission', () => {
    for (const permission of PERMISSIONS) expect(hasPermission('owner', permission)).toBe(true);
  });

  it('keeps staff management to the owner', () => {
    for (const role of STAFF_ROLES.filter((role) => role !== 'owner')) {
      expect(hasPermission(role, 'staff.manage')).toBe(false);
    }
  });

  it('maps every role and grants only known permissions', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...STAFF_ROLES].sort());
    for (const granted of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of granted) expect(PERMISSIONS).toContain(permission);
    }
  });

  it('names permissions `<area>.<action>`', () => {
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+(-[a-z]+)*\.[a-z]+(-[a-z]+)*$/);
    }
  });
});
