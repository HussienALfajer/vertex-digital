import { describe, expect, it } from 'vitest';
import {
  adminUsdtTransferQuerySchema,
  approvalFlags,
  approvalNeedsReauthentication,
  approveDepositSchema,
  approveUsdtDepositSchema,
  canTransitionDeposit,
  createShamCashDepositSchema,
  createUsdtDepositSchema,
  DEPOSIT_FLAG_CODES,
  DEPOSIT_FLAG_DETAILS,
  DEPOSIT_SETTINGS_DEFAULTS,
  DEPOSIT_STATUSES,
  type DepositStatus,
  depositCreditUsdUnits,
  depositLimitBreach,
  depositLimitSettingsFor,
  depositLimits,
  depositSettingsInputSchema,
  dHash,
  dHashDistance,
  isFinalDepositStatus,
  isWholeDepositAmount,
  isWithinReviewHours,
  nextReviewOpening,
  referenceCodeSchema,
  rejectDepositSchema,
  reviewEta,
  reviewEtaMinutes,
  sameFlags,
  submitTxidSchema,
} from './deposits.js';

const USD = 1_000_000;

describe('deposit transitions (S03 "Deposit states")', () => {
  const allowed: [DepositStatus, DepositStatus][] = [
    ['pending', 'submitted'],
    ['pending', 'cancelled'],
    ['pending', 'expired'],
    ['submitted', 'credited'],
    ['submitted', 'rejected'],
    ['submitted', 'pending'],
  ];

  it('allows exactly the moves of the table', () => {
    for (const from of DEPOSIT_STATUSES) {
      for (const to of DEPOSIT_STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransitionDeposit(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it('makes credited, rejected, expired and cancelled final', () => {
    expect(DEPOSIT_STATUSES.filter(isFinalDepositStatus)).toEqual([
      'credited',
      'rejected',
      'expired',
      'cancelled',
    ]);
  });
});

describe('reference codes', () => {
  it('normalizes case, spaces and a missing dash', () => {
    expect(referenceCodeSchema.parse('VD-7KQ2M')).toBe('VD-7KQ2M');
    expect(referenceCodeSchema.parse(' vd-7kq2m ')).toBe('VD-7KQ2M');
    expect(referenceCodeSchema.parse('vd7kq2m')).toBe('VD-7KQ2M');
  });

  it('refuses characters that read alike, a wrong length or no prefix', () => {
    for (const value of ['VD-0KQ2M', 'VD-OKQ2M', 'VD-1KQ2M', 'VD-IKQ2M', 'VD-LKQ2M', 'VD-7KQ2']) {
      expect(referenceCodeSchema.safeParse(value).success, value).toBe(false);
    }
    expect(referenceCodeSchema.safeParse('7KQ2M').success).toBe(false);
    expect(referenceCodeSchema.safeParse('VD-7KQ2MM').success).toBe(false);
  });
});

describe('amounts and the credit (rules SC2, RV2, FX6)', () => {
  it('takes whole pounds and whole cents', () => {
    expect(isWholeDepositAmount('SYP', 200_000)).toBe(true);
    expect(isWholeDepositAmount('SYP', 200_050)).toBe(false);
    expect(isWholeDepositAmount('USD', 25 * USD)).toBe(true);
    expect(isWholeDepositAmount('USD', 25 * USD + 1)).toBe(false);
  });

  it('validates the create input by currency', () => {
    expect(
      createShamCashDepositSchema.safeParse({ currency: 'SYP', amountUnits: 200_000 }).success,
    ).toBe(true);
    const pounds = createShamCashDepositSchema.safeParse({ currency: 'SYP', amountUnits: 200_050 });
    expect(pounds.error?.issues[0]?.message).toBe('Expected whole pounds');
    const cents = createShamCashDepositSchema.safeParse({ currency: 'USD', amountUnits: 1 });
    expect(cents.error?.issues[0]?.message).toBe('Expected whole cents');
    expect(createShamCashDepositSchema.safeParse({ currency: 'USD', amountUnits: 0 }).success).toBe(
      false,
    );
  });

  it('credits USD as received and converts pounds down to whole cents', () => {
    expect(depositCreditUsdUnits('USD', 25 * USD, null)).toBe(25 * USD);
    expect(depositCreditUsdUnits('SYP', 190_000, '118')).toBe(16_100_000);
    expect(() => depositCreditUsdUnits('SYP', 190_000, null)).toThrow(RangeError);
  });

  it('needs a re-authentication above $100 or with any flag (rule RV4)', () => {
    expect(approvalNeedsReauthentication(100 * USD, 0)).toBe(false);
    expect(approvalNeedsReauthentication(100 * USD + 10_000, 0)).toBe(true);
    expect(approvalNeedsReauthentication(5 * USD, 1)).toBe(true);
  });
});

describe('approval-time flags (rules RV5, FL6)', () => {
  const deposit = { currency: 'SYP' as const, declaredAmountUnits: 200_000 };

  it('raises none when the transfer matches', () => {
    expect(
      approvalFlags(deposit, {
        receivedCurrency: 'SYP',
        receivedAmountUnits: 200_000,
        referenceCheck: 'matches',
      }),
    ).toEqual([]);
  });

  it('flags a different amount or currency and a missing or different reference', () => {
    expect(
      approvalFlags(deposit, {
        receivedCurrency: 'SYP',
        receivedAmountUnits: 190_000,
        referenceCheck: 'missing',
      }),
    ).toEqual(['amount_mismatch', 'reference_missing']);
    expect(
      approvalFlags(deposit, {
        receivedCurrency: 'USD',
        receivedAmountUnits: 200_000,
        referenceCheck: 'different',
      }),
    ).toEqual(['amount_mismatch', 'reference_different']);
  });

  it('compares acknowledgements as sets', () => {
    expect(sameFlags(['velocity', 'amount_mismatch'], ['amount_mismatch', 'velocity'])).toBe(true);
    expect(sameFlags(['velocity', 'velocity'], ['velocity'])).toBe(true);
    expect(sameFlags(['velocity'], ['velocity', 'shared_phone'])).toBe(false);
    expect(sameFlags(['velocity'], ['shared_phone'])).toBe(false);
    expect(sameFlags([], [])).toBe(true);
  });

  it('describes the details of every flag', () => {
    expect(Object.keys(DEPOSIT_FLAG_DETAILS).sort()).toEqual([...DEPOSIT_FLAG_CODES].sort());
    expect(DEPOSIT_FLAG_DETAILS.reference_missing.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('the approve, reject and request schemas', () => {
  const approval = {
    transactionNumber: ' TEST-001 ',
    receivedCurrency: 'SYP',
    receivedAmountUnits: 190_000,
    referenceCheck: 'matches',
    acknowledgedFlags: [],
  } as const;

  it('trims the transaction number and checks the received amount by currency', () => {
    expect(approveDepositSchema.parse(approval).transactionNumber).toBe('TEST-001');
    const pounds = approveDepositSchema.safeParse({ ...approval, receivedAmountUnits: 190_001 });
    expect(pounds.error?.issues[0]?.message).toBe('Expected whole pounds');
    const cents = approveDepositSchema.safeParse({
      ...approval,
      receivedCurrency: 'USD',
      receivedAmountUnits: 1,
    });
    expect(cents.error?.issues[0]?.message).toBe('Expected whole cents');
  });

  it('needs a customer note for another reason', () => {
    const base = { reason: 'other', internalNote: 'checked the account' } as const;
    expect(rejectDepositSchema.safeParse(base).success).toBe(false);
    expect(rejectDepositSchema.safeParse({ ...base, customerNote: 'wrong bank' }).success).toBe(
      true,
    );
    expect(
      rejectDepositSchema.safeParse({ reason: 'not_received', internalNote: 'nothing arrived' })
        .success,
    ).toBe(true);
  });
});

describe('limits (rule SC3)', () => {
  const settings = DEPOSIT_SETTINGS_DEFAULTS;

  it('gives a new account $50 per deposit and $100 a day', () => {
    expect(depositLimits(settings, false, 30 * USD)).toEqual({
      established: false,
      minUnits: 2 * USD,
      perDepositUnits: 50 * USD,
      dailyUnits: 100 * USD,
      remainingTodayUnits: 70 * USD,
    });
  });

  it('gives an established account $300 and $1,000, never a negative remainder', () => {
    expect(depositLimits(settings, true, 0).perDepositUnits).toBe(300 * USD);
    expect(depositLimits(settings, true, 1200 * USD)).toMatchObject({
      dailyUnits: 1000 * USD,
      remainingTodayUnits: 0,
    });
  });

  it('names the limit a deposit breaks', () => {
    const limits = depositLimits(settings, false, 60 * USD);
    expect(depositLimitBreach(limits, 1 * USD)).toEqual({
      limit: 'minimum',
      limitUnits: 2 * USD,
      remainingUnits: 40 * USD,
    });
    expect(depositLimitBreach(limits, 60 * USD)).toEqual({
      limit: 'per_deposit',
      limitUnits: 50 * USD,
      remainingUnits: 40 * USD,
    });
    expect(depositLimitBreach(limits, 45 * USD)).toEqual({
      limit: 'daily',
      limitUnits: 100 * USD,
      remainingUnits: 40 * USD,
    });
    expect(depositLimitBreach(limits, 40 * USD)).toBeNull();
    expect(depositLimitBreach(limits, 2 * USD)).toBeNull();
  });
});

describe('review hours and the ETA (rule SC13)', () => {
  const hours = { start: '10:00', end: '22:00' };
  // Damascus is UTC+3: 10:00 there is 07:00 UTC.
  const at = (utc: string) => new Date(utc);

  it('opens at the start and closes at the end, in Damascus time', () => {
    expect(isWithinReviewHours(at('2026-10-08T06:59:00Z'), hours)).toBe(false); // 09:59
    expect(isWithinReviewHours(at('2026-10-08T07:00:00Z'), hours)).toBe(true); // 10:00
    expect(isWithinReviewHours(at('2026-10-08T18:59:00Z'), hours)).toBe(true); // 21:59
    expect(isWithinReviewHours(at('2026-10-08T19:00:00Z'), hours)).toBe(false); // 22:00
  });

  it('gives the next opening today before the start, else tomorrow', () => {
    expect(nextReviewOpening(at('2026-10-08T06:59:00Z'), hours).toISOString()).toBe(
      '2026-10-08T07:00:00.000Z',
    );
    expect(nextReviewOpening(at('2026-10-08T19:00:00Z'), hours).toISOString()).toBe(
      '2026-10-09T07:00:00.000Z',
    );
    // After midnight in Damascus (21:30 UTC the day before) the opening is the same local day.
    expect(nextReviewOpening(at('2026-10-31T21:30:00Z'), hours).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    // The last day of a month runs into the next.
    expect(nextReviewOpening(at('2026-12-31T20:00:00Z'), hours).toISOString()).toBe(
      '2027-01-01T07:00:00.000Z',
    );
  });

  it('uses the target with fewer than 5 decisions', () => {
    expect(reviewEtaMinutes([60, 60, 60, 60], 15)).toBe(15);
  });

  it('rounds the median up to 5 minutes, at least 5', () => {
    expect(reviewEtaMinutes([60, 120, 60, 30, 90], 15)).toBe(5);
    // Odd count: median 11 minutes → 15.
    expect(reviewEtaMinutes([600, 660, 700, 3000, 100], 15)).toBe(15);
    // Even count: median (600 + 1300) / 2 = 950 s → 20 minutes.
    expect(reviewEtaMinutes([100, 600, 1300, 2000, 300, 4000], 15)).toBe(20);
    expect(reviewEtaMinutes([1200, 1200, 1200, 1200, 1200], 15)).toBe(20);
  });

  it('gives an ETA within hours and the next opening outside them', () => {
    expect(reviewEta(at('2026-10-08T07:00:00Z'), hours, 15, [])).toEqual({
      state: 'open',
      minutes: 15,
    });
    expect(reviewEta(at('2026-10-08T19:00:00Z'), hours, 15, [])).toEqual({
      state: 'closed',
      opensAt: '2026-10-09T07:00:00.000Z',
    });
  });
});

describe('receipt dHash (rule FL2)', () => {
  const image = (value: (row: number, column: number) => number) =>
    Uint8Array.from({ length: 72 }, (_, index) => value(Math.floor(index / 9), index % 9));

  it('sets a bit where the left neighbour is brighter', () => {
    expect(dHash(image(() => 100))).toBe(0n);
    // Brighter on the left everywhere: all 64 bits set, -1 as a signed 64-bit integer.
    expect(dHash(image((_, column) => 255 - column))).toBe(-1n);
    // Only the first pair of the last row.
    expect(dHash(image((row, column) => (row === 7 && column === 0 ? 200 : 100)))).toBe(128n);
  });

  it('refuses another size', () => {
    expect(() => dHash(new Uint8Array(64))).toThrow(RangeError);
  });

  it('counts the differing bits, signed or not', () => {
    expect(dHashDistance(0n, 0n)).toBe(0);
    expect(dHashDistance(0n, -1n)).toBe(64);
    expect(dHashDistance(0b1011n, 0b0001n)).toBe(2);
  });
});

describe('deposit settings', () => {
  const valid = {
    ...DEPOSIT_SETTINGS_DEFAULTS,
    shamCashAccountName: 'Vertex',
    shamCashAccountNumber: '0933 000 000',
  };
  const fileId = '01890000-0000-7000-8000-000000000001';
  const issues = (input: object) =>
    depositSettingsInputSchema.safeParse(input).error?.issues.map((issue) => issue.path[0]) ?? [];

  it('accepts the defaults with an account', () => {
    expect(issues(valid)).toEqual([]);
  });

  it('needs the QR image of an enabled currency', () => {
    expect(issues({ ...valid, sypEnabled: true, usdEnabled: true })).toEqual([
      'sypQrFileId',
      'usdQrFileId',
    ]);
    expect(issues({ ...valid, sypEnabled: true, sypQrFileId: fileId })).toEqual([]);
  });

  it('keeps min ≤ per deposit ≤ daily for each tier', () => {
    expect(issues({ ...valid, minDepositUsdUnits: 60 * USD })).toEqual([
      'newAccountPerDepositUsdUnits',
    ]);
    expect(issues({ ...valid, establishedDailyUsdUnits: 200 * USD })).toEqual([
      'establishedDailyUsdUnits',
    ]);
  });

  it('keeps the hours in order and the amounts in whole cents above zero', () => {
    expect(issues({ ...valid, reviewHoursEnd: '10:00' })).toEqual(['reviewHoursEnd']);
    expect(issues({ ...valid, reviewHoursStart: '24:00' })).toContain('reviewHoursStart');
    expect(issues({ ...valid, flagNewAccountUsdUnits: 0 })).toEqual(['flagNewAccountUsdUnits']);
    expect(issues({ ...valid, minDepositUsdUnits: 2 * USD + 1 })).toEqual(['minDepositUsdUnits']);
  });

  it('defaults the USDT switches off and keeps the USDT minimum within both tiers (S04)', () => {
    expect(DEPOSIT_SETTINGS_DEFAULTS.usdtTrc20Enabled).toBe(false);
    expect(DEPOSIT_SETTINGS_DEFAULTS.usdtMinDepositUsdUnits).toBe(5 * USD);
    expect(issues({ ...valid, usdtMinDepositUsdUnits: 50 * USD })).toEqual([]);
    expect(issues({ ...valid, usdtMinDepositUsdUnits: 51 * USD })).toEqual([
      'usdtMinDepositUsdUnits',
    ]);
    expect(issues({ ...valid, usdtMinDepositUsdUnits: 0 })).toEqual(['usdtMinDepositUsdUnits']);
  });

  it('keeps the Telegram approval limit within $0–$100 in whole cents (S05 rule TC4)', () => {
    expect(DEPOSIT_SETTINGS_DEFAULTS.telegramApprovalMaxUsdUnits).toBe(100 * USD);
    expect(issues({ ...valid, telegramApprovalMaxUsdUnits: 0 })).toEqual([]);
    expect(issues({ ...valid, telegramApprovalMaxUsdUnits: 100 * USD + 10_000 })).toEqual([
      'telegramApprovalMaxUsdUnits',
    ]);
    expect(issues({ ...valid, telegramApprovalMaxUsdUnits: 1 })).toEqual([
      'telegramApprovalMaxUsdUnits',
    ]);
  });
});

describe('USDT deposits (S04)', () => {
  const HASH = 'ab'.repeat(32);

  it('take the USDT minimum in their limits (rule U5)', () => {
    const settings = { ...DEPOSIT_SETTINGS_DEFAULTS };
    expect(depositLimitSettingsFor('sham_cash', settings).minDepositUsdUnits).toBe(2 * USD);
    const usdt = depositLimitSettingsFor('usdt_trc20', settings);
    expect(usdt.minDepositUsdUnits).toBe(5 * USD);
    const limits = depositLimits(usdt, false, 0);
    expect(depositLimitBreach(limits, 4 * USD)).toMatchObject({ limit: 'minimum' });
    expect(depositLimitBreach(limits, 5 * USD)).toBeNull();
  });

  it('are created for a USDT method and whole cents above zero (rule U2)', () => {
    const ok = createUsdtDepositSchema.safeParse({ method: 'usdt_bep20', amountUnits: 25 * USD });
    expect(ok.success).toBe(true);
    for (const input of [
      { method: 'sham_cash', amountUnits: 25 * USD },
      { method: 'usdt_trc20', amountUnits: 0 },
      { method: 'usdt_trc20', amountUnits: 25 * USD + 100 },
    ]) {
      expect(createUsdtDepositSchema.safeParse(input).success).toBe(false);
    }
  });

  it('take a pasted TXID as text, for the API to normalize (rule U8)', () => {
    expect(submitTxidSchema.parse({ txid: ` 0x${HASH} ` })).toEqual({ txid: `0x${HASH}` });
    expect(submitTxidSchema.safeParse({ txid: ' ' }).success).toBe(false);
  });

  it('approve with flags acknowledged and no amount (rule U15)', () => {
    expect(approveUsdtDepositSchema.parse({ acknowledgedFlags: ['wrong_network'] })).toEqual({
      acknowledgedFlags: ['wrong_network'],
    });
    expect(
      approveUsdtDepositSchema.safeParse({ acknowledgedFlags: [], receivedAmountUnits: 1 }).success,
    ).toBe(true);
    expect(approveUsdtDepositSchema.safeParse({ acknowledgedFlags: ['nope'] }).success).toBe(false);
  });

  it('list unmatched transfers by default (rule U13)', () => {
    expect(adminUsdtTransferQuerySchema.parse({})).toEqual({ limit: 50, state: 'unmatched' });
    expect(adminUsdtTransferQuerySchema.safeParse({ state: 'bound' }).success).toBe(false);
  });

  it('describe their review flags', () => {
    expect(
      DEPOSIT_FLAG_DETAILS.wrong_network.safeParse({
        depositMethod: 'usdt_trc20',
        transferMethod: 'usdt_bep20',
      }).success,
    ).toBe(true);
    expect(
      DEPOSIT_FLAG_DETAILS.sent_before_deposit.safeParse({
        depositCreatedAt: '2026-10-08T10:00:00.000Z',
        blockTime: '2026-10-08T09:59:00.000Z',
      }).success,
    ).toBe(true);
  });
});
