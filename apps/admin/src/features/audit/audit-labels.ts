import {
  type AuditEntry,
  adjustmentCategorySchema,
  adjustmentDirectionSchema,
  formatUsd,
  manualDepositMethodSchema,
} from '@vertex-digital/contracts';
import type { TFunction } from 'i18next';
import ar from '../../i18n/locales/ar.json';

/** Who did it: the admin, "customer: <name>", the system or the CLI. */
export function actorLabel(t: TFunction, entry: AuditEntry): string {
  if (entry.actorKind === 'customer' && entry.actorName) {
    return t('audit.actorCustomer', { name: entry.actorName });
  }
  return t(`audit.actorKinds.${entry.actorKind}`);
}

/** A field of the details: its label when the catalog has one, else its key as written. */
export function fieldLabel(t: TFunction, key: string): string {
  return key in ar.audit.fields ? t(`audit.fields.${key as keyof typeof ar.audit.fields}`) : key;
}

/** A value as written: `—` when missing, JSON for anything that is not a string. */
const asWritten = (value: unknown) =>
  value === undefined || value === null
    ? '—'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

/**
 * A field's value for reading: USD amounts as dollars, wallet adjustment codes by their labels
 * (S02), anything else as written.
 */
export function fieldValue(t: TFunction, key: string, value: unknown): string {
  if ((key === 'amountUnits' || key === 'balanceAfterUnits') && Number.isSafeInteger(value)) {
    return formatUsd(value as number);
  }
  const direction = adjustmentDirectionSchema.safeParse(value);
  if (key === 'direction' && direction.success) {
    return t(`wallets.directions.${direction.data}`);
  }
  const category = adjustmentCategorySchema.safeParse(value);
  if (key === 'category' && category.success) return t(`wallets.categories.${category.data}`);
  const method = manualDepositMethodSchema.safeParse(value);
  if (key === 'depositMethod' && method.success) return t(`wallets.methods.${method.data}`);
  return asWritten(value);
}

/** The first block of a UUID, enough to tell entries apart in the table. */
export const shortId = (id: string) => id.slice(0, 8);
