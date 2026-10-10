import { z } from 'zod';

/*
 * A customer's administrative status (S12, owner 2026-10-10), kept apart from `customers.ts` so the
 * deposit, order and support shapes can show it without importing the customer administration
 * (which imports them for its search).
 */

export const CUSTOMER_STATUSES = ['active', 'frozen', 'archived'] as const;

export const customerStatusSchema = z.enum(CUSTOMER_STATUSES).meta({ id: 'CustomerStatus' });

export type CustomerStatus = z.infer<typeof customerStatusSchema>;

/** S12 data: archived wins over frozen (an archived customer keeps `frozen_at`, rule AR2). */
export function customerStatus(customer: {
  frozenAt: Date | string | null;
  archivedAt: Date | string | null;
}): CustomerStatus {
  if (customer.archivedAt !== null) return 'archived';
  if (customer.frozenAt !== null) return 'frozen';
  return 'active';
}

/**
 * What the panel shows beside a customer on a deposit, an order or a ticket (rule CS6): the status,
 * the pinned note and how many other customers the signals list (CS5).
 */
export const customerMarksSchema = z
  .object({
    status: customerStatusSchema,
    pinnedNote: z.string().nullable(),
    signalsCount: z.int().nonnegative(),
  })
  .meta({ id: 'CustomerMarks' });

export type CustomerMarks = z.infer<typeof customerMarksSchema>;
