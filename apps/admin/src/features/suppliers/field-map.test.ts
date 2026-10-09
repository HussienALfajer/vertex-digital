import { describe, expect, it } from 'vitest';
import { fieldMapEntries, requiredFieldsOf, toFieldMap, unmappedOf } from './field-map';

describe('fieldMapEntries', () => {
  it('lists the required fields first, then the other mapped ones', () => {
    expect(fieldMapEntries(['playerId', 'zoneId'], { zoneId: 'zone', extra: 'server' })).toEqual([
      { field: 'playerId', key: '', required: true },
      { field: 'zoneId', key: 'zone', required: true },
      { field: 'extra', key: 'server', required: false },
    ]);
    expect(fieldMapEntries([])).toEqual([]);
  });
});

describe('toFieldMap', () => {
  it('keeps the rows with a field and a key, trimmed', () => {
    expect(
      toFieldMap([
        { field: 'playerId', key: 'player_id', required: true },
        { field: 'zoneId', key: '', required: true },
        { field: ' server ', key: 'server', required: false },
        { field: ' ', key: 'other', required: false },
      ]),
    ).toEqual({ playerId: 'player_id', server: 'server' });
  });
});

describe('requiredFieldsOf', () => {
  it('names each known field once, unknown ones adding nothing', () => {
    expect(
      requiredFieldsOf([
        { requiredFields: ['playerId'] },
        { requiredFields: null },
        { requiredFields: ['playerId', 'zoneId'] },
      ]),
    ).toEqual(['playerId', 'zoneId']);
  });
});

describe('unmappedOf', () => {
  it('reads the fields of a ROUTE_FIELDS_UNMAPPED refusal', () => {
    expect(unmappedOf({ details: { fields: ['playerId'] } })).toEqual(['playerId']);
    expect(unmappedOf({ details: {} })).toEqual([]);
    expect(unmappedOf(null)).toEqual([]);
  });
});
