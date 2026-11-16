import { describe, expect, it } from 'vitest';
import {
  approveRateSuggestionSchema,
  changeRateSchema,
  createRateSourceSchema,
  DEFAULT_RATE_SETTINGS,
  type DecisionFigure,
  DISPLAY_STEP_MAX_SYP_UNITS,
  DISPLAY_STEP_MIN_SYP_UNITS,
  decideRate,
  displayStepSchema,
  figureSeenAt,
  isFigureInRange,
  isFreshFigure,
  isRateSourceHandle,
  isRateStale,
  maxDisplayStepSypUnits,
  normaliseRateSourceHandle,
  type RateSettingsValues,
  rateConfirmationError,
  rateSettingsValuesSchema,
  rateSourceHealth,
  rateSuggestionListQuerySchema,
  telegramMayApproveRate,
  testRateSourceSchema,
  updateRateSourceSchema,
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

describe('display step against the cheapest product (S07 rule P9)', () => {
  it('allows at most 2% of the cheapest SYP value, in whole pounds', () => {
    // $0.60 at 13,000 SYP: 7,800 SYP; 2% is 156 SYP, so at most 156 pounds (beyond FX3's 50).
    expect(maxDisplayStepSypUnits('13000', 600_000)).toBe(15_600);
    // $0.10 at 1,000: 100 SYP; 2% is 2 SYP.
    expect(maxDisplayStepSypUnits('1000', 100_000)).toBe(200);
    // $0.10 at 1,249: 124.9 SYP; 2% is 2.498 SYP, rounded down to 2 pounds.
    expect(maxDisplayStepSypUnits('1249', 100_000)).toBe(200);
    // Below one pound: FX3's minimum step stays allowed, so a rate can always be changed.
    expect(maxDisplayStepSypUnits('10', 100_000)).toBe(100);
    // $0.30 at 118: 35.4 SYP, 2% is 0.7 pounds.
    expect(maxDisplayStepSypUnits('118', 300_000)).toBe(100);
  });
});

describe('rate sources (S27 data, SR5)', () => {
  const parser = { cityWord: 'دمشق', sellWord: 'مبيع', unit: 'new_syp' } as const;

  it('accepts channel usernames and sp-today paths only', () => {
    expect(isRateSourceHandle('telegram_channel', 'syp_rates_1')).toBe(true);
    expect(isRateSourceHandle('sp_today_page', '/currency/us-dollar')).toBe(true);
    for (const handle of ['abcd', 'a'.repeat(33), 'evil.com', 'https://t.me/x', 'name-x']) {
      expect(isRateSourceHandle('telegram_channel', handle)).toBe(false);
    }
    for (const handle of ['currency', '/Currency', '//evil.com', '/a//b', '/a.b', '/a?x=1']) {
      expect(isRateSourceHandle('sp_today_page', handle)).toBe(false);
    }
  });

  it('validates a new source with its parser and the default sell keyword', () => {
    const source = createRateSourceSchema.parse({
      kind: 'telegram_channel',
      label: 'قناة دمشق',
      handle: 'damascus_rates',
      parser: { cityWord: null, unit: 'old_syp' },
    });
    expect(source).toMatchObject({ enabled: true, parser: { sellWord: 'مبيع' } });
    const wrong = createRateSourceSchema.safeParse({ ...source, handle: '/currency/us-dollar' });
    expect(wrong.error?.issues[0]?.path).toEqual(['handle']);
    const test = testRateSourceSchema.safeParse({ kind: 'sp_today_page', handle: '/x', parser });
    expect(test.success).toBe(true);
    expect(updateRateSourceSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('reads a source as broken after one out-of-range or three failed reads', () => {
    expect(rateSourceHealth([])).toBe('unknown');
    expect(rateSourceHealth([{ status: 'ok' }, { status: 'no_match' }])).toBe('ok');
    expect(rateSourceHealth([{ status: 'out_of_range' }, { status: 'ok' }])).toBe('broken');
    expect(rateSourceHealth([{ status: 'no_match' }, { status: 'fetch_failed' }])).toBe('unknown');
    const failed = [{ status: 'no_match' }, { status: 'fetch_failed' }, { status: 'no_match' }];
    expect(rateSourceHealth(failed as { status: 'no_match' }[])).toBe('broken');
    expect(
      rateSourceHealth([{ status: 'no_match' }, { status: 'fetch_failed' }, { status: 'ok' }]),
    ).toBe('unknown');
  });

  it('refuses figures more than 20% from the current rate (SR3)', () => {
    expect(isFigureInRange('130', '156')).toBe(true);
    expect(isFigureInRange('130', '104')).toBe(true);
    expect(isFigureInRange('130', '156.01')).toBe(false);
    expect(isFigureInRange('130', '1.32')).toBe(false);
  });
});

describe('fresh figures (S27 SR4)', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('dates a figure by its post time, else by when it was first seen', () => {
    expect(figureSeenAt({ postedAt: minutesAgo(10) }, minutesAgo(600))).toEqual(minutesAgo(10));
    expect(figureSeenAt({ postedAt: null }, minutesAgo(600))).toEqual(minutesAgo(600));
  });

  it('keeps a figure fresh up to the window and not a minute beyond', () => {
    expect(isFreshFigure(minutesAgo(180), now, 180)).toBe(true);
    expect(isFreshFigure(minutesAgo(181), now, 180)).toBe(false);
  });

  it('stores one handle per channel or page', () => {
    expect(normaliseRateSourceHandle('telegram_channel', ' @SyriaRates ')).toBe('syriarates');
    expect(normaliseRateSourceHandle('sp_today_page', '/currency/us-dollar//')).toBe(
      '/currency/us-dollar',
    );
    expect(normaliseRateSourceHandle('sp_today_page', '/')).toBe('/');
    const parser = { cityWord: null, unit: 'new_syp' } as const;
    expect(
      createRateSourceSchema.parse({
        kind: 'telegram_channel',
        label: 'قناة',
        handle: '@Damascus_Rates',
        parser,
      }).handle,
    ).toBe('damascus_rates');
    expect(
      testRateSourceSchema.parse({ kind: 'sp_today_page', handle: '/currency/us-dollar/', parser })
        .handle,
    ).toBe('/currency/us-dollar');
  });
});

describe('the decision after a poll (S27 AU2–AU6)', () => {
  const on: RateSettingsValues = { ...DEFAULT_RATE_SETTINGS, autoEnabled: true };
  const figures = (...rates: string[]): DecisionFigure[] =>
    rates.map((sypPerUsd, index) => ({ observationId: `o${index}`, sypPerUsd }));
  const decide = (rates: string[], overrides: Partial<Parameters<typeof decideRate>[0]> = {}) =>
    decideRate({
      current: '130',
      driftBase: '130',
      figures: figures(...rates),
      settings: on,
      pending: null,
      rejected: [],
      ...overrides,
    });

  it('does nothing without figures or below the minimum move', () => {
    expect(decide([])).toEqual({ kind: 'none' });
    // 0.25% of 130 is 0.325: 130.31 rounds up to 24 bp, 130.325 is exactly 25.
    expect(decide(['130.31', '130.3'])).toEqual({ kind: 'none' });
    expect(decide(['130.325', '130.3'])).toMatchObject({ kind: 'auto', changeBps: 25 });
  });

  it('applies the highest of two agreeing figures within 2% alone', () => {
    expect(decide(['131', '131.5'])).toEqual({
      kind: 'auto',
      sypPerUsd: '131.5',
      changeBps: 116,
      observationIds: ['o0', 'o1'],
    });
    expect(decide(['132.6', '132'])).toMatchObject({ kind: 'auto', changeBps: 200 });
  });

  it('suggests when one condition fails, naming the first that failed', () => {
    expect(decide(['131'], { settings: DEFAULT_RATE_SETTINGS })).toMatchObject({
      kind: 'suggest',
      reason: 'auto_off',
    });
    expect(decide(['131'])).toMatchObject({ kind: 'suggest', reason: 'single_source' });
    // 1% of 131 is 1.31: 132.31 agrees, 132.32 does not.
    expect(decide(['131', '132.31'])).toMatchObject({ kind: 'auto' });
    expect(decide(['131', '132.32'])).toMatchObject({
      kind: 'suggest',
      reason: 'sources_disagree',
      sypPerUsd: '132.32',
    });
    expect(decide(['130.5', '131.8'])).toMatchObject({ kind: 'auto' });
    expect(decide(['132.61', '132.61'])).toMatchObject({
      kind: 'suggest',
      reason: 'move_too_large',
    });
    expect(decide(['131', '131'], { driftBase: '128' })).toMatchObject({
      kind: 'suggest',
      reason: 'drift_too_large',
    });
    expect(decide(['131', '131'], { driftBase: '128.44' })).toMatchObject({ kind: 'auto' });
    const three = { ...on, minAgreeingSources: 3 };
    expect(decide(['131', '131'], { settings: three })).toMatchObject({
      reason: 'single_source',
    });
    expect(decide(['131', '131', '131'], { settings: three })).toMatchObject({ kind: 'auto' });
  });

  it('keeps a pending suggestion and a recent rejection of nearly the same value', () => {
    expect(decide(['140'], { pending: '139.7' })).toEqual({ kind: 'none' });
    expect(decide(['140'], { pending: '139.6' })).toMatchObject({ kind: 'suggest' });
    expect(decide(['140'], { rejected: ['139.9', '120'] })).toEqual({ kind: 'none' });
    expect(decide(['140'], { rejected: ['139'] })).toMatchObject({ kind: 'suggest' });
    // An automatic move needs no card: the pending one is superseded by the write.
    expect(decide(['131', '131'], { pending: '131' })).toMatchObject({ kind: 'auto' });
  });
});

describe('rate settings and suggestions (S27 ST2, SG1–SG3)', () => {
  it('holds every threshold within its bounds', () => {
    expect(rateSettingsValuesSchema.parse(DEFAULT_RATE_SETTINGS)).toEqual(DEFAULT_RATE_SETTINGS);
    for (const change of [
      { autoMaxMoveBps: 301 },
      { agreementMaxSpreadBps: 24 },
      { minAgreeingSources: 1 },
      { driftMaxBps: 501 },
      { telegramApproveMaxBps: 501 },
      { freshnessMinutes: 721 },
      { silentAlertHours: 0 },
      { pollMinutes: 9 },
    ]) {
      const parsed = rateSettingsValuesSchema.safeParse({ ...DEFAULT_RATE_SETTINGS, ...change });
      expect(parsed.success).toBe(false);
    }
  });

  it('lets Telegram approve up to its cap, and never above 5%', () => {
    const cap = { telegramApproveMaxBps: 500 };
    expect(telegramMayApproveRate('130', '136.5', cap)).toBe(true);
    expect(telegramMayApproveRate('130', '136.51', cap)).toBe(false);
    expect(telegramMayApproveRate('130', '132', { telegramApproveMaxBps: 100 })).toBe(false);
    expect(telegramMayApproveRate('130', '136.5', { telegramApproveMaxBps: 900 })).toBe(true);
    expect(telegramMayApproveRate('130', '137', { telegramApproveMaxBps: 900 })).toBe(false);
  });

  it('approves the proposed value or an edited one, and filters the list by status', () => {
    expect(approveRateSuggestionSchema.parse({})).toEqual({});
    expect(approveRateSuggestionSchema.safeParse({ sypPerUsd: '-1' }).success).toBe(false);
    expect(rateSuggestionListQuerySchema.parse({ status: 'pending' })).toMatchObject({
      status: 'pending',
    });
  });
});
