import { HEALTH_PROBE_REASON } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { healthReason } from './health-reason';

describe('healthReason', () => {
  it('reads back each reason supplierHealth builds', () => {
    expect(healthReason('3 consecutive errors')).toEqual({
      key: 'consecutive',
      values: { count: '3' },
    });
    expect(healthReason('2 calls < 5')).toEqual({
      key: 'fewCalls',
      values: { calls: '2', min: '5' },
    });
    expect(healthReason('success 82% < 90%')).toEqual({
      key: 'successBelow',
      values: { success: '82%', threshold: '90%' },
    });
    expect(healthReason('p90 12000 ms > 10000 ms')).toEqual({
      key: 'slow',
      values: { p90: '12000', max: '10000' },
    });
    expect(healthReason('success 100%')).toEqual({ key: 'success', values: { success: '100%' } });
    expect(healthReason(HEALTH_PROBE_REASON)).toEqual({ key: 'probe', values: {} });
  });

  it('keeps an unknown reason as it came', () => {
    expect(healthReason('something else')).toEqual({
      key: 'unknown',
      values: { reason: 'something else' },
    });
  });

  it('reads the S18 recovery reasons', () => {
    expect(healthReason('recovering: success 94% < 95%')).toEqual({
      key: 'recovering',
      values: { success: '94%', threshold: '95%' },
    });
    expect(healthReason('recovering: held 2 of 5 minutes')).toEqual({
      key: 'holding',
      values: { held: '2', minutes: '5' },
    });
  });
});
