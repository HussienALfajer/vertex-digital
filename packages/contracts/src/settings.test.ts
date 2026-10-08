import { describe, expect, it } from 'vitest';
import { DEPOSIT_METHODS, depositMethodState } from './deposits.js';
import {
  DEPOSIT_PAUSE_SWITCHES,
  depositStopReason,
  STORE_SWITCH_DEFAULTS,
  STORE_SWITCHES,
  SUPPLIER_PAUSE_SWITCHES,
  storeStatus,
  switchHistoryQuerySchema,
} from './settings.js';

describe('store switches (S05 F26)', () => {
  it('default to registration closed and nothing stopped (rules SW1, SW8)', () => {
    expect(Object.keys(STORE_SWITCH_DEFAULTS).sort()).toEqual([...STORE_SWITCHES].sort());
    expect(Object.values(STORE_SWITCH_DEFAULTS).every((value) => value === false)).toBe(true);
  });

  it('derive the public store status', () => {
    expect(storeStatus(STORE_SWITCH_DEFAULTS)).toEqual({
      registrationOpen: false,
      purchasesStopped: false,
      depositsStopped: false,
    });
    expect(
      storeStatus({
        ...STORE_SWITCH_DEFAULTS,
        registration_open: true,
        purchases_stopped: true,
        deposits_stopped: true,
        sham_cash_paused: true,
      }),
    ).toEqual({ registrationOpen: true, purchasesStopped: true, depositsStopped: true });
  });

  it('pause each deposit method with its own switch (rule SW4)', () => {
    expect(Object.keys(DEPOSIT_PAUSE_SWITCHES).sort()).toEqual([...DEPOSIT_METHODS].sort());
    for (const method of DEPOSIT_METHODS) {
      const paused = { ...STORE_SWITCH_DEFAULTS, [DEPOSIT_PAUSE_SWITCHES[method]]: true };
      expect(depositStopReason(paused, method)).toBe('method_paused');
      expect(depositStopReason(STORE_SWITCH_DEFAULTS, method)).toBeNull();
      expect(
        depositStopReason({ ...paused, deposits_stopped: true }, method),
        'the emergency stop wins',
      ).toBe('emergency');
    }
    expect(
      depositStopReason({ ...STORE_SWITCH_DEFAULTS, sham_cash_paused: true }, 'usdt_trc20'),
    ).toBeNull();
  });

  it('give each deposit method a state (rule SW6)', () => {
    expect(depositMethodState({ stopped: true, paused: true, ready: false })).toBe('stopped');
    expect(depositMethodState({ stopped: false, paused: true, ready: true })).toBe('paused');
    expect(depositMethodState({ stopped: false, paused: false, ready: false })).toBe('unavailable');
    expect(depositMethodState({ stopped: false, paused: false, ready: true })).toBe('available');
  });

  it('filter the history by switch', () => {
    expect(switchHistoryQuerySchema.parse({ switch: 'deposits_stopped' })).toMatchObject({
      switch: 'deposits_stopped',
      limit: 50,
    });
    expect(switchHistoryQuerySchema.safeParse({ switch: 'other' }).success).toBe(false);
  });
});

describe('supplier switches (S07 rule SP3)', () => {
  it('give each supplier its own pause switch', () => {
    const switches = Object.values(SUPPLIER_PAUSE_SWITCHES);
    expect(new Set(switches).size).toBe(switches.length);
    for (const value of switches) expect(STORE_SWITCHES).toContain(value);
  });
});
