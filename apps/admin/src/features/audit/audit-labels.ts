import type { AuditEntry } from '@vertex-digital/contracts';
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

/** The first block of a UUID, enough to tell entries apart in the table. */
export const shortId = (id: string) => id.slice(0, 8);
