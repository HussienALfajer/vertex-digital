import { z } from 'zod';

/**
 * Kinds of ledger account (ADR 0003): one USD wallet per customer, and the system accounts. A
 * customer wallet never goes negative; the system accounts may.
 */
export const LEDGER_ACCOUNT_KINDS = [
  'customer_wallet',
  'sham_cash_receipts',
  'usdt_receipts',
  'supplier_prepaid',
  'sales_revenue',
  'cost_of_goods',
  'refunds',
  'adjustments',
] as const;

export const ledgerAccountKindSchema = z
  .enum(LEDGER_ACCOUNT_KINDS)
  .meta({ id: 'LedgerAccountKind' });

export type LedgerAccountKind = z.infer<typeof ledgerAccountKindSchema>;

/** Kinds of money event, one journal each (ADR 0003, F03 timeline). */
export const JOURNAL_KINDS = [
  'deposit',
  'purchase',
  'refund',
  'cost_of_goods',
  'adjustment',
] as const;

export const journalKindSchema = z.enum(JOURNAL_KINDS).meta({ id: 'JournalKind' });

export type JournalKind = z.infer<typeof journalKindSchema>;
