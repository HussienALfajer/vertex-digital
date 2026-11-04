import {
  AMOUNT_STEP,
  amountOfQuantity,
  groupRecipient,
  normalizeSyrianMobile,
  quantityOfAmount,
  RECIPIENT_FIELD_OPERATOR,
  type RecipientFieldType,
  type ServiceClass,
  type StoreField,
  type SyrianOperator,
} from '@vertex-digital/contracts';
import { tcr } from './i18n';

/*
 * The credit section's display rules in the store (S25 AM1, AM6, RN1, RN2, SC2): which games are
 * in the section, the free amount typed and shown, and the recipient compared and shown. The
 * server decides everything again.
 */

/** CL1: a `credit` or `cash` game is in the section (a page cached before S25 has no class). */
export function inSection(serviceClass: ServiceClass | undefined): boolean {
  return serviceClass === 'credit' || serviceClass === 'cash';
}

/** S25 Data: a section game has one field, the recipient, typed twice (RN2). */
export function recipientFieldOf(
  serviceClass: ServiceClass | undefined,
  fields: readonly StoreField[],
): StoreField | null {
  return inSection(serviceClass) ? (fields[0] ?? null) : null;
}

/** RN1: the operator a recipient field takes, or null for a `digits` one (bills, RN4). */
export function operatorOf(field: Pick<StoreField, 'type'>): SyrianOperator | null {
  return field.type in RECIPIENT_FIELD_OPERATOR
    ? RECIPIENT_FIELD_OPERATOR[field.type as RecipientFieldType]
    : null;
}

const ARABIC_INDIC = /[٠-٩۰-۹]/g;

function latinDigits(value: string): string {
  return value.replace(ARABIC_INDIC, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** A recipient as compared: a mobile line normalised (RN1), anything else its digits. */
function comparable(field: StoreField, value: string): string | null {
  if (operatorOf(field)) return normalizeSyrianMobile(value);
  const digits = latinDigits(value).replace(/[\s-]/g, '');
  return digits === '' ? null : digits;
}

/** RN2: the two typed numbers are one recipient ("0933 123 456" and "+963 933123456"). */
export function sameRecipient(field: StoreField, first: string, second: string): boolean {
  const a = comparable(field, first);
  return a !== null && a === comparable(field, second);
}

/** RN2: a mobile line grouped `09X XXX XXXX`; any other value as typed. */
export function shownRecipient(field: Pick<StoreField, 'type'>, value: string): string {
  const normalized = operatorOf(field) ? normalizeSyrianMobile(value) : null;
  return normalized ? groupRecipient(normalized) : value;
}

/** A typed amount ("7,300", "٧٣٠٠") as a whole number, or null when it holds anything else. */
export function typedAmount(text: string): number | null {
  const compact = latinDigits(text).replace(/[\s,٬]/g, '');
  return /^\d{1,9}$/.test(compact) ? Number(compact) : null;
}

export interface AmountPack {
  minQuantity: number;
  maxQuantity: number;
  amountStep: number | null;
  amountUnitAr: string | null;
}

const stepOf = (pack: Pick<AmountPack, 'amountStep'>) => pack.amountStep ?? AMOUNT_STEP;

/** AM1: the quantity of a typed amount, or null when it is outside the bounds or the steps. */
export function amountQuantity(pack: AmountPack, text: string): number | null {
  const amount = typedAmount(text);
  return amount === null ? null : quantityOfAmount(amount, { ...pack, step: stepOf(pack) });
}

const grouped = (value: number) => value.toLocaleString('en-US');

/** AM6: "7,300 ل.س", never a quantity. */
export function amountText(
  pack: Pick<AmountPack, 'amountStep' | 'amountUnitAr'>,
  quantity: number,
): string {
  return tcr('amount.value', {
    amount: grouped(amountOfQuantity(quantity, stepOf(pack))),
    unit: pack.amountUnitAr ?? '',
  });
}

/** The face amount of a quantity as typed back into the input ("7300"). */
export function amountInput(pack: Pick<AmountPack, 'amountStep'>, quantity: number): string {
  return String(amountOfQuantity(quantity, stepOf(pack)));
}

/** AM1, AM6: the bounds' words: `{ min: "1,000", max: "100,000", step: "100", unit: "ل.س" }`. */
export function amountBounds(pack: AmountPack): Record<'min' | 'max' | 'step' | 'unit', string> {
  const step = stepOf(pack);
  return {
    min: grouped(amountOfQuantity(pack.minQuantity, step)),
    max: grouped(amountOfQuantity(pack.maxQuantity, step)),
    step: grouped(step),
    unit: pack.amountUnitAr ?? '',
  };
}

/** RN3: an order's stored recipient, grouped when it is a mobile line (a bill's ID as it is). */
export function shownLine(value: string): string {
  const normalized = normalizeSyrianMobile(value);
  return normalized ? groupRecipient(normalized) : value;
}
