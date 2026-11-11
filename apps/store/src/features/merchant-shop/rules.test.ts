import { describe, expect, it } from 'vitest';
import {
  barShares,
  checkHolds,
  colorVerdict,
  confirmWordTyped,
  freesTransferKey,
  normalizeColor,
  remainingToday,
  returnAmount,
  shopUrl,
  slugProblem,
  transferPreview,
} from './rules';

const USD = 1_000_000;

describe("متجري's rules (S26 PR 4)", () => {
  it('explains a slug before the availability check (SH2)', () => {
    expect(slugProblem('abu-omar')).toBeNull();
    expect(slugProblem('ab')).toBe('invalid');
    expect(slugProblem('-abc')).toBe('invalid');
    expect(slugProblem('أبو')).toBe('invalid');
    expect(slugProblem('admin')).toBe('reserved');
  });

  it('reads a typed color and its contrast verdict (ST1)', () => {
    expect(normalizeColor('1F7A6C')).toBe('#1f7a6c');
    expect(normalizeColor('#12')).toBeNull();
    expect(colorVerdict('#1f7a6c')).toBe('ok');
    expect(colorVerdict('#ffff00')).toBe('white_text');
    expect(colorVerdict('#0a0a0a')).toBe('dark_theme');
    expect(colorVerdict('zz')).toBe('invalid');
  });

  it('takes «أؤكد» only as written (ST3)', () => {
    expect(confirmWordTyped(' أؤكد ')).toBe(true);
    expect(confirmWordTyped('اؤكد')).toBe(false);
  });

  it('previews a transfer: SYP down to whole cents, at least $0.10 (WL2)', () => {
    expect(transferPreview('syp', '', '13000')).toEqual({ kind: 'empty' });
    expect(transferPreview('syp', '10000', null)).toEqual({ kind: 'no_rate' });
    expect(transferPreview('syp', '10000', '13000')).toEqual({
      kind: 'ok',
      amountUnits: 1_000_000,
      usdUnits: 760_000,
    });
    expect(transferPreview('syp', '100.5', '13000')).toEqual({ kind: 'invalid' });
    expect(transferPreview('syp', '1000', '13000')).toEqual({
      kind: 'below_minimum',
      usdUnits: 70_000,
    });
    expect(transferPreview('usd', '5.25', null)).toEqual({
      kind: 'ok',
      amountUnits: 5_250_000,
      usdUnits: 5_250_000,
    });
    expect(transferPreview('usd', '5.255', null)).toEqual({ kind: 'invalid' });
    expect(transferPreview('usd', '0', null)).toEqual({ kind: 'invalid' });
  });

  it("counts today's remaining cap and the password check's window (WL3, WL4)", () => {
    expect(remainingToday(1_000 * USD, 300 * USD)).toBe(700 * USD);
    expect(remainingToday(10 * USD, 30 * USD)).toBe(0);
    expect(checkHolds(null, 0)).toBe(false);
    expect(checkHolds('2026-11-11T10:15:00.000Z', Date.parse('2026-11-11T10:00:00.000Z'))).toBe(
      true,
    );
    expect(checkHolds('2026-11-11T10:15:00.000Z', Date.parse('2026-11-11T10:16:00.000Z'))).toBe(
      false,
    );
  });

  it('takes a return amount up to the balance (WL5)', () => {
    expect(returnAmount('5', 10 * USD)).toBe(5 * USD);
    expect(returnAmount('10.01', 10 * USD)).toBeNull();
    expect(returnAmount('0', 10 * USD)).toBeNull();
    expect(returnAmount('abc', 10 * USD)).toBeNull();
  });

  it('builds the link and the bars', () => {
    expect(shopUrl('https://digital.vertexmedia.pro', 'abu-omar')).toBe(
      'https://digital.vertexmedia.pro/s/abu-omar',
    );
    expect(barShares([0, 5, 10])).toEqual([0, 0.5, 1]);
    expect(barShares([0, 0])).toEqual([0, 0]);
  });

  it('frees a transfer key only on refusals after its lookup (WL1)', () => {
    expect(freesTransferKey('SHOP_BALANCE_CAP_EXCEEDED', true)).toBe(true);
    expect(freesTransferKey('INSUFFICIENT_BALANCE', false)).toBe(true);
    expect(freesTransferKey('VALIDATION_FAILED', false)).toBe(true);
    expect(freesTransferKey('VALIDATION_FAILED', true)).toBe(false);
    for (const reason of [
      'NETWORK',
      'INTERNAL_ERROR',
      'IDEMPOTENCY_KEY_REUSED',
      'RATE_LIMITED',
      'REAUTHENTICATION_REQUIRED',
    ]) {
      expect(freesTransferKey(reason, false)).toBe(false);
    }
  });
});
