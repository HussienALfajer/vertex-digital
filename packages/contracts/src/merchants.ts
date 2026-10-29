import { z } from 'zod';
import { phoneSchema } from './auth.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { adminMerchantTierSchema } from './merchant-tiers.js';
import { amountUnitsSchema, isWholeCents, USD_CENT } from './money.js';
import { merchantTierSchema, priceKindSchema } from './price-kinds.js';

/*
 * Merchant accounts (S20 F28, ADR 0035), owned by the api `merchants` module: the application and
 * its review, the merchant profile, the merchant terms and the merchant settings (the deposit tier,
 * the order rate, the reapply wait and the information expiry). Imports no pricing or catalog
 * module, so the store's application form stays light.
 */

/* The form's lists (F28) --------------------------------------------------------------------- */

export const MERCHANT_ACTIVITIES = [
  'phone_shop',
  'gaming_lounge',
  'services_shop',
  'wholesale_distributor',
  'online_store',
  'other',
] as const;

export const merchantActivitySchema = z.enum(MERCHANT_ACTIVITIES).meta({ id: 'MerchantActivity' });

export type MerchantActivity = z.infer<typeof merchantActivitySchema>;

export const YEARS_IN_BUSINESS = ['under_1', '1_3', 'over_3'] as const;

export const yearsInBusinessSchema = z.enum(YEARS_IN_BUSINESS).meta({ id: 'YearsInBusiness' });

export type YearsInBusiness = z.infer<typeof yearsInBusinessSchema>;

export const GOVERNORATES = [
  'damascus',
  'rif_dimashq',
  'aleppo',
  'homs',
  'hama',
  'latakia',
  'tartus',
  'idlib',
  'deir_ez_zor',
  'raqqa',
  'hasakah',
  'daraa',
  'as_suwayda',
  'quneitra',
  'outside_syria',
] as const;

export const governorateSchema = z.enum(GOVERNORATES).meta({ id: 'Governorate' });

export type Governorate = z.infer<typeof governorateSchema>;

export const MONTHLY_VOLUMES = [
  'under_200',
  '200_500',
  '500_2000',
  '2000_5000',
  'over_5000',
] as const;

export const monthlyVolumeSchema = z.enum(MONTHLY_VOLUMES).meta({ id: 'MonthlyVolume' });

export type MonthlyVolume = z.infer<typeof monthlyVolumeSchema>;

export const PRODUCT_INTERESTS = ['game_topups', 'gift_cards', 'chat_apps'] as const;

export const productInterestSchema = z.enum(PRODUCT_INTERESTS).meta({ id: 'ProductInterest' });

export type ProductInterest = z.infer<typeof productInterestSchema>;

export const SALES_CHANNELS = [
  'shop_counter',
  'whatsapp_telegram',
  'social_pages',
  'online_store',
] as const;

export const salesChannelSchema = z.enum(SALES_CHANNELS).meta({ id: 'SalesChannel' });

export type SalesChannel = z.infer<typeof salesChannelSchema>;

export const HEARD_FROM = [
  'friend_or_shop',
  'facebook',
  'instagram',
  'telegram',
  'whatsapp',
  'search',
  'other',
] as const;

export const heardFromSchema = z.enum(HEARD_FROM).meta({ id: 'HeardFrom' });

export type HeardFrom = z.infer<typeof heardFromSchema>;

/* Applications (MA1–MA8) --------------------------------------------------------------------- */

export const MERCHANT_APPLICATION_STATUSES = [
  'under_review',
  'info_requested',
  'approved',
  'rejected',
  'expired',
  'withdrawn',
] as const;

export const merchantApplicationStatusSchema = z
  .enum(MERCHANT_APPLICATION_STATUSES)
  .meta({ id: 'MerchantApplicationStatus' });

export type MerchantApplicationStatus = z.infer<typeof merchantApplicationStatusSchema>;

/** At most one application per customer is in one of these (the partial unique index). */
export const OPEN_APPLICATION_STATUSES = [
  'under_review',
  'info_requested',
] as const satisfies readonly MerchantApplicationStatus[];

export function isOpenApplication(status: MerchantApplicationStatus): boolean {
  return (OPEN_APPLICATION_STATUSES as readonly MerchantApplicationStatus[]).includes(status);
}

/** The customer's timeline (`merchant_application_events`). */
export const MERCHANT_APPLICATION_EVENTS = [
  'submitted',
  'info_requested',
  'resubmitted',
  'approved',
  'rejected',
  'expired',
  'withdrawn',
] as const;

export const merchantApplicationEventKindSchema = z
  .enum(MERCHANT_APPLICATION_EVENTS)
  .meta({ id: 'MerchantApplicationEventKind' });

export type MerchantApplicationEventKind = z.infer<typeof merchantApplicationEventKindSchema>;

/**
 * What moves an application (MA4); `grant` is MA6's direct grant, which closes an open application
 * as approved.
 */
export type ApplicationAction =
  | 'request_info'
  | 'resubmit'
  | 'approve'
  | 'reject'
  | 'withdraw'
  | 'expire'
  | 'grant';

const APPLICATION_TRANSITIONS: Record<
  ApplicationAction,
  readonly [readonly MerchantApplicationStatus[], MerchantApplicationStatus]
> = {
  request_info: [['under_review'], 'info_requested'],
  resubmit: [['info_requested'], 'under_review'],
  approve: [['under_review'], 'approved'],
  reject: [['under_review'], 'rejected'],
  withdraw: [['under_review', 'info_requested'], 'withdrawn'],
  expire: [['info_requested'], 'expired'],
  grant: [['under_review', 'info_requested'], 'approved'],
};

/** MA4: the status an action leads to, or null when the move is refused (`APPLICATION_STATE_INVALID`). */
export function applicationTransition(
  status: MerchantApplicationStatus,
  action: ApplicationAction,
): MerchantApplicationStatus | null {
  const [from, to] = APPLICATION_TRANSITIONS[action];
  return from.includes(status) ? to : null;
}

/** The event each action writes on the timeline. */
export const APPLICATION_ACTION_EVENTS: Record<ApplicationAction, MerchantApplicationEventKind> = {
  request_info: 'info_requested',
  resubmit: 'resubmitted',
  approve: 'approved',
  reject: 'rejected',
  withdraw: 'withdrawn',
  expire: 'expired',
  grant: 'approved',
};

const DAY_MS = 86_400_000;

/** MA1, edge case 13: a rejected customer may apply again from this instant. */
export function reapplyAvailableAt(decidedAt: Date, reapplyWaitDays: number): Date {
  return new Date(decidedAt.getTime() + reapplyWaitDays * DAY_MS);
}

/** MA4, edge case 14: an information request expires at this instant. */
export function infoRequestExpiresAt(infoRequestedAt: Date, infoExpiryDays: number): Date {
  return new Date(infoRequestedAt.getTime() + infoExpiryDays * DAY_MS);
}

/** Why a customer may not apply now (MA1, MT1), in the order the API checks them. */
export type MerchantApplyRefusal =
  | { code: 'ALREADY_MERCHANT' }
  | { code: 'ACCOUNT_FROZEN' }
  | { code: 'MERCHANT_TERMS_UNAVAILABLE' }
  | { code: 'MERCHANT_APPLICATION_OPEN'; applicationId: string }
  | { code: 'MERCHANT_REAPPLY_TOO_SOON'; availableAt: Date };

/** MA1, MT1: null when the customer may apply now. */
export function merchantApplyRefusal(state: {
  accountType: 'customer' | 'merchant';
  frozen: boolean;
  termsPublished: boolean;
  latest: { id: string; status: MerchantApplicationStatus; decidedAt: Date | null } | null;
  reapplyWaitDays: number;
  now: Date;
}): MerchantApplyRefusal | null {
  if (state.accountType === 'merchant') return { code: 'ALREADY_MERCHANT' };
  if (state.frozen) return { code: 'ACCOUNT_FROZEN' };
  if (!state.termsPublished) return { code: 'MERCHANT_TERMS_UNAVAILABLE' };
  const latest = state.latest;
  if (latest === null) return null;
  if (isOpenApplication(latest.status)) {
    return { code: 'MERCHANT_APPLICATION_OPEN', applicationId: latest.id };
  }
  if (latest.status === 'rejected' && latest.decidedAt !== null) {
    const availableAt = reapplyAvailableAt(latest.decidedAt, state.reapplyWaitDays);
    if (state.now < availableAt) return { code: 'MERCHANT_REAPPLY_TOO_SOON', availableAt };
  }
  return null;
}

/* The form (MA2) ----------------------------------------------------------------------------- */

// Anything that looks like a link (MA2: links only in `shopLink`).
const LINK =
  /https?:|www\.|:\/\/|\b[\w-]+\.(?:com|net|org|io|me|co|info|xyz|sy|link|shop|store|app)\b/i;

/** A trimmed one-line text of `min` to `max` characters, without control characters or links. */
export const merchantText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u)
    .refine((value) => !LINK.test(value), 'Links are not allowed here');

/** The admin's message or reason the customer reads, 5–500 (MA4, MA6, MA7). */
export const merchantMessageSchema = z
  .string()
  .trim()
  .min(5)
  .max(500)
  .regex(/^(?:[^\p{Cc}]|\n)+$/u);

const distinct = <Item extends z.ZodType>(item: Item, min: number, max: number) =>
  z
    .array(item)
    .min(min)
    .max(max)
    .refine((values) => new Set(values).size === values.length, 'Values must be distinct');

export const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;

/** `POST` and `PUT /api/merchant/application` (MA2). */
export const merchantApplicationInputSchema = z
  .object({
    tradeName: merchantText(2, 80),
    activity: merchantActivitySchema,
    /** Required only for `other`. */
    activityOther: merchantText(2, 80).nullable(),
    yearsInBusiness: yearsInBusinessSchema,
    governorate: governorateSchema,
    city: merchantText(2, 60),
    streetAddress: merchantText(5, 160),
    whatsapp: phoneSchema,
    /** Without `@`. */
    telegramUsername: z
      .string()
      .trim()
      .transform((value) => value.replace(/^@/, ''))
      .pipe(z.string().regex(TELEGRAM_USERNAME_PATTERN))
      .nullable(),
    monthlyVolume: monthlyVolumeSchema,
    productInterests: distinct(productInterestSchema, 1, 3),
    salesChannels: distinct(salesChannelSchema, 1, 4),
    /** From `POST /api/merchant/application/photo` (MA3). */
    shopPhotoFileId: z.uuid().nullable(),
    shopLink: z
      .string()
      .trim()
      .max(300)
      .pipe(z.url({ protocol: /^https$/ }))
      .nullable(),
    /** The `merchant_terms` version the customer accepted: the one in force (MT2). */
    termsVersionId: z.uuid(),
    heardFrom: heardFromSchema.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.activity === 'other') !== (value.activityOther !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['activityOther'],
        message: 'Required for "other" only',
      });
    }
  })
  .meta({ id: 'MerchantApplicationInput' });

export type MerchantApplicationInput = z.input<typeof merchantApplicationInputSchema>;

export type MerchantApplicationValues = z.output<typeof merchantApplicationInputSchema>;

/** The stored form, as both the customer and the admin read it. */
const applicationForm = {
  tradeName: z.string(),
  activity: merchantActivitySchema,
  activityOther: z.string().nullable(),
  yearsInBusiness: yearsInBusinessSchema,
  governorate: governorateSchema,
  city: z.string(),
  streetAddress: z.string(),
  whatsapp: z.string(),
  telegramUsername: z.string().nullable(),
  monthlyVolume: monthlyVolumeSchema,
  productInterests: z.array(productInterestSchema),
  salesChannels: z.array(salesChannelSchema),
  shopPhotoFileId: z.uuid().nullable(),
  shopLink: z.string().nullable(),
  heardFrom: heardFromSchema.nullable(),
};

export const merchantApplicationEventSchema = z
  .object({
    event: merchantApplicationEventKindSchema,
    /** The admin's text the customer reads (information requested, rejection reason). */
    message: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MerchantApplicationEvent' });

export type MerchantApplicationEvent = z.infer<typeof merchantApplicationEventSchema>;

/** An application as its customer reads it. */
export const merchantApplicationSchema = z
  .object({
    id: z.uuid(),
    status: merchantApplicationStatusSchema,
    ...applicationForm,
    /** The information requested or the rejection reason. */
    adminMessage: z.string().nullable(),
    submittedAt: z.iso.datetime(),
    infoRequestedAt: z.iso.datetime().nullable(),
    /** When an information request expires (`info_requested` only). */
    expiresAt: z.iso.datetime().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    events: z.array(merchantApplicationEventSchema),
  })
  .meta({ id: 'MerchantApplication' });

export type MerchantApplication = z.infer<typeof merchantApplicationSchema>;

/** `GET /api/merchant/application`: the latest application and whether a new one is allowed. */
export const merchantApplicationStateSchema = z
  .object({
    application: merchantApplicationSchema.nullable(),
    canApply: z.boolean(),
    /** A rejected customer's first day to apply again (MA1); null otherwise. */
    availableAt: z.iso.datetime().nullable(),
    /** The `merchant_terms` version in force; null before the first is published (MT1). */
    termsVersionId: z.uuid().nullable(),
  })
  .meta({ id: 'MerchantApplicationState' });

export type MerchantApplicationState = z.infer<typeof merchantApplicationStateSchema>;

/** `POST /api/merchant/application/photo`. */
export const merchantPhotoSchema = z.object({ fileId: z.uuid() }).meta({ id: 'MerchantPhoto' });

export type MerchantPhoto = z.infer<typeof merchantPhotoSchema>;

/** `POST /api/merchant/terms` (MT2): the version in force. */
export const acceptMerchantTermsSchema = z
  .object({ versionId: z.uuid() })
  .meta({ id: 'AcceptMerchantTerms' });

export type AcceptMerchantTerms = z.infer<typeof acceptMerchantTermsSchema>;

/* Admin -------------------------------------------------------------------------------------- */

/** `GET /api/admin/merchant-applications`: no status lists every application (MA8). */
export const merchantApplicationListQuerySchema = cursorQuerySchema
  .extend({ status: merchantApplicationStatusSchema.optional() })
  .meta({ id: 'MerchantApplicationListQuery' });

export type MerchantApplicationListQuery = z.infer<typeof merchantApplicationListQuerySchema>;

const applicationCustomer = {
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
};

/** A row of the queue (MA8, screens): the flags beside the form's headline. */
export const adminMerchantApplicationRowSchema = z
  .object({
    id: z.uuid(),
    status: merchantApplicationStatusSchema,
    tradeName: z.string(),
    governorate: governorateSchema,
    activity: merchantActivitySchema,
    monthlyVolume: monthlyVolumeSchema,
    submittedAt: z.iso.datetime(),
    customer: z.object({
      ...applicationCustomer,
      frozen: z.boolean(),
      /** Other accounts with the same phone (S12 signals). */
      sharedPhone: z.int().nonnegative(),
      /** Created within `NEW_ACCOUNT_DAYS`. */
      newAccount: z.boolean(),
    }),
  })
  .meta({ id: 'AdminMerchantApplicationRow' });

export type AdminMerchantApplicationRow = z.infer<typeof adminMerchantApplicationRowSchema>;

export const adminMerchantApplicationPageSchema = cursorPageSchema(
  adminMerchantApplicationRowSchema,
  'AdminMerchantApplicationPage',
);

export type AdminMerchantApplicationPage = z.infer<typeof adminMerchantApplicationPageSchema>;

/** An account younger than this is flagged "new" in the queue. */
export const NEW_ACCOUNT_DAYS = 30;

/**
 * `GET /api/admin/merchant-applications/:id`: the form, the events and earlier applications; the
 * customer's summary and signals come from the customer profile (`GET /api/admin/customers/:id`),
 * read beside it.
 */
export const adminMerchantApplicationSchema = merchantApplicationSchema
  .extend({
    customer: z.object({ ...applicationCustomer, phone: z.string() }),
    termsVersion: z.int().positive(),
    approvedPriceList: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    earlier: z.array(
      z.object({
        id: z.uuid(),
        status: merchantApplicationStatusSchema,
        submittedAt: z.iso.datetime(),
        decidedAt: z.iso.datetime().nullable(),
      }),
    ),
  })
  .meta({ id: 'AdminMerchantApplication' });

export type AdminMerchantApplication = z.infer<typeof adminMerchantApplicationSchema>;

/** `POST …/request-info` (MA4). */
export const requestApplicationInfoSchema = z
  .object({ message: merchantMessageSchema })
  .meta({ id: 'RequestApplicationInfo' });

export type RequestApplicationInfo = z.infer<typeof requestApplicationInfoSchema>;

/** `POST …/reject` (MA4). */
export const rejectApplicationSchema = z
  .object({ reason: merchantMessageSchema })
  .meta({ id: 'RejectApplication' });

export type RejectApplication = z.infer<typeof rejectApplicationSchema>;

/** `POST …/approve` (MA5): no list is the merchant default, wholesale. */
export const approveApplicationSchema = z
  .object({ priceListId: z.uuid().optional() })
  .meta({ id: 'ApproveApplication' });

export type ApproveApplication = z.infer<typeof approveApplicationSchema>;

/** `POST /api/admin/customers/:id/merchant` (MA6). */
export const grantMerchantSchema = z
  .object({
    tradeName: merchantText(2, 80),
    governorate: governorateSchema,
    city: merchantText(2, 60),
    priceListId: z.uuid().optional(),
    reason: merchantMessageSchema,
  })
  .meta({ id: 'GrantMerchant' });

export type GrantMerchant = z.infer<typeof grantMerchantSchema>;

/** `POST /api/admin/customers/:id/merchant/revoke` (MA7). */
export const revokeMerchantSchema = z
  .object({ reason: merchantMessageSchema })
  .meta({ id: 'RevokeMerchant' });

export type RevokeMerchant = z.infer<typeof revokeMerchantSchema>;

/** S21: a volume level by name (its list is the admin's to see on the levels page). */
export const merchantLevelRefSchema = z
  .object({ id: z.uuid(), nameAr: z.string() })
  .meta({ id: 'MerchantLevelRef' });

/** The merchant profile on the admin customer profile; null for an account never a merchant. */
export const adminMerchantProfileSchema = z
  .object({
    tradeName: z.string(),
    governorate: governorateSchema,
    city: z.string(),
    /** Null for a direct grant. */
    applicationId: z.uuid().nullable(),
    /** The accepted `merchant_terms` version; null until accepted (MT2). */
    termsVersion: z.int().positive().nullable(),
    grantedAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    /** S21 LV4: the volume level and since when; null for none. */
    level: merchantLevelRefSchema.nullable(),
    levelChangedAt: z.iso.datetime().nullable(),
    /** S23 AD5: the effective and earned tiers, the source and the grants. */
    tier: adminMerchantTierSchema,
    /** S21 LV2: net wallet purchases of this and the previous Damascus month. */
    thisMonthUsdUnits: z.int(),
    previousMonthUsdUnits: z.int(),
    /** S21 AL1: the follows. */
    watchCount: z.int().nonnegative(),
    /** S21 BR3: the receipt branding the merchant set (the admin may remove the logo). */
    branding: z.object({
      showWhatsapp: z.boolean(),
      whatsapp: z.string().nullable(),
      logoFileId: z.uuid().nullable(),
    }),
  })
  .meta({ id: 'AdminMerchantProfile' });

export type AdminMerchantProfile = z.infer<typeof adminMerchantProfileSchema>;

/** `GET /api/admin/merchants`. */
export const merchantListQuerySchema = cursorQuerySchema
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    listId: z.uuid().optional(),
    /** S21: a level's merchants, or `none` for merchants without a level. */
    levelId: z.union([z.uuid(), z.literal('none')]).optional(),
    /** S23 AD1: the merchants holding a tier now, or `granted` for a granted tier. */
    tier: z.union([merchantTierSchema, z.literal('granted')]).optional(),
  })
  .meta({ id: 'MerchantListQuery' });

export type MerchantListQuery = z.infer<typeof merchantListQuerySchema>;

export const adminMerchantRowSchema = z
  .object({
    customerId: z.uuid(),
    name: z.string(),
    email: z.string(),
    tradeName: z.string(),
    governorate: governorateSchema,
    city: z.string(),
    /** The effective list. */
    priceList: z.object({ id: z.uuid(), name: z.string() }),
    priceKind: priceKindSchema,
    /** S21 LV4. */
    level: merchantLevelRefSchema.nullable(),
    /** S23 AD1: the effective tier and whether it is granted. */
    tier: merchantTierSchema,
    tierGranted: z.boolean(),
    termsAccepted: z.boolean(),
    frozen: z.boolean(),
    grantedAt: z.iso.datetime(),
    /** Delivered sales of the last 30 days, net of refunds. */
    sales30dUsdUnits: amountUnitsSchema,
  })
  .meta({ id: 'AdminMerchantRow' });

export type AdminMerchantRow = z.infer<typeof adminMerchantRowSchema>;

export const adminMerchantPageSchema = cursorPageSchema(
  adminMerchantRowSchema,
  'AdminMerchantPage',
);

export type AdminMerchantPage = z.infer<typeof adminMerchantPageSchema>;

/* Settings (MD1, PO5, MA1, MA4) -------------------------------------------------------------- */

/** The seeded values (owner decisions 1, 7, 8). */
export const MERCHANT_SETTINGS_DEFAULTS = {
  perDepositUsdUnits: 2_000 * 1_000_000,
  dailyDepositUsdUnits: 5_000 * 1_000_000,
  ordersPerTenMinutes: 60,
  reapplyWaitDays: 7,
  infoExpiryDays: 7,
  playerChecksPerHour: 100,
  playerChecksPerDay: 300,
} as const;

/** A customer's order rate (PO5): orders and checkouts per 10 minutes. */
export const CUSTOMER_ORDERS_PER_TEN_MINUTES = 10;

/** At most $100,000 for a merchant limit (as S12's overrides). */
export const MERCHANT_LIMIT_MAX_USD_UNITS = 100_000 * 1_000_000;

const merchantLimit = z
  .int()
  .min(USD_CENT)
  .max(MERCHANT_LIMIT_MAX_USD_UNITS)
  .refine(isWholeCents, 'Expected whole cents');

/** `PUT /api/admin/merchant-settings`. */
export const merchantSettingsInputSchema = z
  .object({
    perDepositUsdUnits: merchantLimit,
    dailyDepositUsdUnits: merchantLimit,
    ordersPerTenMinutes: z.int().min(10).max(500),
    reapplyWaitDays: z.int().min(0).max(365),
    infoExpiryDays: z.int().min(1).max(60),
    /** S21 BK4: a merchant's player checks, replacing S09's 10 an hour and 30 a day. */
    playerChecksPerHour: z.int().min(10).max(1_000),
    playerChecksPerDay: z.int().min(30).max(5_000),
  })
  .refine((value) => value.perDepositUsdUnits <= value.dailyDepositUsdUnits, {
    path: ['perDepositUsdUnits'],
    message: 'Above the daily limit',
  })
  .meta({ id: 'MerchantSettingsInput' });

export type MerchantSettingsInput = z.infer<typeof merchantSettingsInputSchema>;

/** `GET` and `PUT /api/admin/merchant-settings`: the values in force and the deposit minimums. */
export const merchantSettingsSchema = z
  .object({
    perDepositUsdUnits: amountUnitsSchema,
    dailyDepositUsdUnits: amountUnitsSchema,
    ordersPerTenMinutes: z.int(),
    reapplyWaitDays: z.int(),
    infoExpiryDays: z.int(),
    playerChecksPerHour: z.int(),
    playerChecksPerDay: z.int(),
    /** The highest deposit minimum (Sham Cash, USDT): both limits must reach it. */
    minDepositUsdUnits: amountUnitsSchema,
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MerchantSettings' });

export type MerchantSettings = z.infer<typeof merchantSettingsSchema>;

/**
 * The settings' check against the deposit minimums (data: both limits at least the Sham Cash and
 * USDT minimums): the fields below them.
 */
export function merchantLimitsBelowMinimum(
  settings: Pick<MerchantSettingsInput, 'perDepositUsdUnits' | 'dailyDepositUsdUnits'>,
  minDepositUsdUnits: number,
): ('perDepositUsdUnits' | 'dailyDepositUsdUnits')[] {
  return (['perDepositUsdUnits', 'dailyDepositUsdUnits'] as const).filter(
    (field) => settings[field] < minDepositUsdUnits,
  );
}

/** MD1: the merchant tier's deposit limits. */
export interface MerchantDepositTier {
  perDepositUsdUnits: number;
  dailyDepositUsdUnits: number;
}
