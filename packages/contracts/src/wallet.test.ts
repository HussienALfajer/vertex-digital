import { describe, expect, it } from 'vitest';
import {
  JOURNAL_KINDS,
  journalKindSchema,
  LEDGER_ACCOUNT_KINDS,
  ledgerAccountKindSchema,
} from './wallet.js';

describe('ledger kinds', () => {
  it('are snake_case, as the database enums that reuse them', () => {
    for (const kind of [...LEDGER_ACCOUNT_KINDS, ...JOURNAL_KINDS]) {
      expect(kind).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('accept only known kinds', () => {
    expect(ledgerAccountKindSchema.safeParse('customer_wallet').success).toBe(true);
    expect(ledgerAccountKindSchema.safeParse('savings').success).toBe(false);
    expect(journalKindSchema.safeParse('purchase').success).toBe(true);
    expect(journalKindSchema.safeParse('withdrawal').success).toBe(false);
  });
});
