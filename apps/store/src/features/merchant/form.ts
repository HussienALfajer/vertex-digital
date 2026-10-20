import {
  type Governorate,
  type HeardFrom,
  type MerchantActivity,
  type MerchantApplication,
  type MerchantApplicationInput,
  type MonthlyVolume,
  merchantApplicationInputSchema,
  type ProductInterest,
  type SalesChannel,
  type YearsInBusiness,
} from '@vertex-digital/contracts';

/*
 * The merchant application form (S20 MA2, screens): four short steps, each checked before the
 * next with the contracts' schema, and the input the API takes. Pure, so it is tested alone.
 */

export const STEPS = ['shop', 'contact', 'activity', 'proof'] as const;

export type Step = (typeof STEPS)[number];

export interface MerchantDraft {
  tradeName: string;
  activity: MerchantActivity | null;
  activityOther: string;
  yearsInBusiness: YearsInBusiness | null;
  governorate: Governorate | null;
  city: string;
  streetAddress: string;
  whatsapp: string;
  telegramUsername: string;
  monthlyVolume: MonthlyVolume | null;
  productInterests: ProductInterest[];
  salesChannels: SalesChannel[];
  heardFrom: HeardFrom | null;
  shopPhotoFileId: string | null;
  shopLink: string;
  termsAccepted: boolean;
}

/** A field of the form, or the terms acceptance. */
export type DraftField = Exclude<keyof MerchantDraft, 'termsAccepted'> | 'terms';

/** The fields each step checks. */
export const STEP_FIELDS: Record<Step, readonly DraftField[]> = {
  shop: [
    'tradeName',
    'activity',
    'activityOther',
    'yearsInBusiness',
    'governorate',
    'city',
    'streetAddress',
  ],
  contact: ['whatsapp', 'telegramUsername'],
  activity: ['monthlyVolume', 'productInterests', 'salesChannels', 'heardFrom'],
  proof: ['shopPhotoFileId', 'shopLink', 'terms'],
};

/** A new form: WhatsApp defaults to the account's phone (MA2). */
export function emptyDraft(phone: string): MerchantDraft {
  return {
    tradeName: '',
    activity: null,
    activityOther: '',
    yearsInBusiness: null,
    governorate: null,
    city: '',
    streetAddress: '',
    whatsapp: phone,
    telegramUsername: '',
    monthlyVolume: null,
    productInterests: [],
    salesChannels: [],
    heardFrom: null,
    shopPhotoFileId: null,
    shopLink: '',
    termsAccepted: false,
  };
}

/** An application's form to edit after a request for information (MA4); the terms again. */
export function draftOf(application: MerchantApplication): MerchantDraft {
  return {
    tradeName: application.tradeName,
    activity: application.activity,
    activityOther: application.activityOther ?? '',
    yearsInBusiness: application.yearsInBusiness,
    governorate: application.governorate,
    city: application.city,
    streetAddress: application.streetAddress,
    whatsapp: application.whatsapp,
    telegramUsername: application.telegramUsername ?? '',
    monthlyVolume: application.monthlyVolume,
    productInterests: application.productInterests,
    salesChannels: application.salesChannels,
    heardFrom: application.heardFrom,
    shopPhotoFileId: application.shopPhotoFileId,
    shopLink: application.shopLink ?? '',
    termsAccepted: false,
  };
}

const optional = (value: string) => (value.trim() === '' ? null : value);

/** What the API takes; empty optional fields are null. */
export function inputOf(draft: MerchantDraft, termsVersionId: string): MerchantApplicationInput {
  return {
    tradeName: draft.tradeName,
    activity: draft.activity as MerchantActivity,
    activityOther: draft.activity === 'other' ? draft.activityOther : null,
    yearsInBusiness: draft.yearsInBusiness as YearsInBusiness,
    governorate: draft.governorate as Governorate,
    city: draft.city,
    streetAddress: draft.streetAddress,
    whatsapp: draft.whatsapp,
    telegramUsername: optional(draft.telegramUsername),
    monthlyVolume: draft.monthlyVolume as MonthlyVolume,
    productInterests: draft.productInterests,
    salesChannels: draft.salesChannels,
    shopPhotoFileId: draft.shopPhotoFileId,
    shopLink: optional(draft.shopLink),
    termsVersionId,
    heardFrom: draft.heardFrom,
  };
}

/** The refused fields of `steps` (all by default), in the form's order. */
export function draftProblems(
  draft: MerchantDraft,
  termsVersionId: string,
  steps: readonly Step[] = STEPS,
): DraftField[] {
  const refused = new Set<DraftField>();
  const parsed = merchantApplicationInputSchema.safeParse(inputOf(draft, termsVersionId));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) refused.add(issue.path[0] as DraftField);
  }
  if (!draft.termsAccepted) refused.add('terms');
  return steps.flatMap((step) => STEP_FIELDS[step]).filter((field) => refused.has(field));
}

/** Adds or removes one choice of a list (product interests, sales channels). */
export function toggled<Value>(values: readonly Value[], value: Value, on: boolean): Value[] {
  const rest = values.filter((item) => item !== value);
  return on ? [...rest, value] : rest;
}
