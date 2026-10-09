import { describe, expect, it } from 'vitest';
import { parseAuditSearch, toAuditQuery } from './audit-search';

const ID = '0199a000-0000-7000-8000-000000000010';

describe('parseAuditSearch', () => {
  it('keeps valid filters', () => {
    expect(
      parseAuditSearch({
        actorKind: 'customer',
        actorId: ` ${ID.toUpperCase()} `,
        action: 'customer.profile_updated',
        entityType: 'customer',
        entityId: ID,
        from: '2026-10-01',
        to: '2026-10-08',
      }),
    ).toEqual({
      actorKind: 'customer',
      actorId: ID,
      action: 'customer.profile_updated',
      entityType: 'customer',
      entityId: ID,
      from: '2026-10-01',
      to: '2026-10-08',
    });
  });

  it('drops anything invalid, and an actor id without its kind', () => {
    expect(
      parseAuditSearch({
        actorKind: 'owner',
        actorId: ID,
        action: 'customer.deleted',
        entityType: 'shipment',
        entityId: 'not-a-uuid',
        from: '08/10/2026',
        to: 42,
      }),
    ).toEqual({});
  });
});

describe('toAuditQuery', () => {
  it('turns calendar days into the whole days of the viewer', () => {
    const query = toAuditQuery({ from: '2026-10-01', to: '2026-10-08', actorKind: 'cli' });
    expect(query.actorKind).toBe('cli');
    expect(new Date(query.from ?? '').getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(new Date(query.to ?? '').getTime()).toBe(new Date(2026, 9, 9).getTime() - 1);
  });
});
