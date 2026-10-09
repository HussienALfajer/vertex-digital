import type { TFunction } from 'i18next';

/** The credential fields the panel names (`SUPPLIER_CREDENTIAL_FIELDS`); others show as they are. */
const LABELLED = ['apiKey', 'webhookSecret'] as const;

type Labelled = (typeof LABELLED)[number];

/** A credential field's label, or its own name for a field an adapter PR adds (Q12). */
export function credentialLabel(t: TFunction, field: string): string {
  return (LABELLED as readonly string[]).includes(field)
    ? t(`suppliers.credentials.fields.${field as Labelled}`)
    : field;
}
