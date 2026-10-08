import { describe, expect, it } from 'vitest';
import {
  changeRateSchema,
  DISPLAY_STEP_MAX_SYP_UNITS,
  DISPLAY_STEP_MIN_SYP_UNITS,
  displayStepSchema,
  isRateStale,
  rateConfirmationError,
} from './rates.js';

describe('display step (rule FX3)', () => {
  it('accepts whole pounds from 1 to 50', () => {
    for (const units of [DISPLAY_STEP_MIN_SYP_UNITS, 500, DISPLAY_STEP_MAX_SYP_UNITS]) {
      expect(displayStepSchema.safeParse(units).success).toBe(true);
    }
  });

  it('refuses fractions of a pound and values out of bounds', () => {
    for (const units of [0, 99, 150, 5100, 500.5]) {
      expect(displayStepSchema.safeParse(units).success).toBe(false);
    }
  });
});

describe('rate change input', () => {
  it('trims the rate and its confirmation', () => {
    expect(
      changeRateSchema.parse({
        sypPerUsd: ' 118.5 ',
        displayStepSypUnits: 500,
        rateConfirmation: ' 118.5 ',
      }),
    ).toEqual({ sypPerUsd: '118.5', displayStepSypUnits: 500, rateConfirmation: '118.5' });
  });

  it('refuses a zero rate', () => {
    expect(changeRateSchema.safeParse({ sypPerUsd: '0', displayStepSypUnits: 500 }).success).toBe(
      false,
    );
  });
});

describe('typed confirmation (rule FX2)', () => {
  it('needs none for the first rate', () => {
    expect(rateConfirmationError(null, { sypPerUsd: '118' })).toBeNull();
  });

  it('needs none for a change of exactly 5%, either way', () => {
    expect(rateConfirmationError('100', { sypPerUsd: '105' })).toBeNull();
    expect(rateConfirmationError('100', { sypPerUsd: '95' })).toBeNull();
  });

  it('requires it just above 5%', () => {
    expect(rateConfirmationError('100', { sypPerUsd: '105.0001' })).toBe(
      'RATE_CONFIRMATION_REQUIRED',
    );
    expect(rateConfirmationError('118', { sypPerUsd: '1180' })).toBe('RATE_CONFIRMATION_REQUIRED');
  });

  it('accepts the same value in another spelling and refuses another value', () => {
    expect(rateConfirmationError('118', { sypPerUsd: '130', rateConfirmation: '130.00' })).toBe(
      null,
    );
    expect(rateConfirmationError('118', { sypPerUsd: '130', rateConfirmation: '13' })).toBe(
      'RATE_CONFIRMATION_MISMATCH',
    );
    expect(rateConfirmationError('118', { sypPerUsd: '130', rateConfirmation: 'abc' })).toBe(
      'RATE_CONFIRMATION_MISMATCH',
    );
  });
});

describe('stale rate (rule FX7)', () => {
  const now = new Date('2026-10-08T12:00:00Z');

  it('treats no rate as stale', () => {
    expect(isRateStale(null, now)).toBe(true);
  });

  it('is stale only after 48 hours', () => {
    expect(isRateStale(new Date('2026-10-06T12:00:00Z'), now)).toBe(false);
    expect(isRateStale(new Date('2026-10-06T11:59:59Z'), now)).toBe(true);
  });
});
