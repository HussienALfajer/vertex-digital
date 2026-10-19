import type {
  Currency,
  OffendingKind,
  ReconciliationCheck,
  ReconciliationDetails,
  ReconciliationResultStatus,
} from '@vertex-digital/contracts';

/** What one check found, before it is stored as a `reconciliation_results` row. */
export interface CheckResult {
  check: ReconciliationCheck;
  subject: string;
  status: ReconciliationResultStatus;
  currency: Currency | null;
  booksUnits: number | null;
  actualUnits: number | null;
  differenceUnits: number | null;
  allowedLowUnits: number | null;
  allowedHighUnits: number | null;
  offendingCount: number;
  details: ReconciliationDetails;
}

export interface Offending {
  kind: OffendingKind;
  id: string;
}

export const noDetails = (): ReconciliationDetails => ({
  offending: [],
  lines: [],
  reason: null,
  unmatchedSupplierOrders: [],
});

/** A safe integer from a `bigint` or `numeric` PostgreSQL text value; null is 0. */
export function units(value: string | number | null | undefined): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new RangeError(`Not a safe integer: ${value}`);
  return result;
}
