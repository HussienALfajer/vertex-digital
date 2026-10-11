import { z } from 'zod';
import { fullNameSchema, phoneSchema } from './auth.js';
import { acceptedVersionSchema } from './content.js';
import { customerStatusSchema } from './customer-status.js';
import { type DepositLimitSettings, referenceCodeSchema } from './deposits.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { amountUnitsSchema, isWholeCents, USD_CENT } from './money.js';
import { orderNumberSchema } from './orders.js';
import { ticketNumberSchema } from './support.js';

/*
 * Customers as the admin sees them. S01: test customers (rules T1–T4), owned by the api `auth`
 * module (it owns the customer tables). S12 (F19): search, the profile, freezing, limits, notes and
 * archiving, owned by the api `customers` module (`customer_limits`, `customer_notes`).
 */

/** A test customer created by the admin. */
export const testCustomerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    phone: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'TestCustomer' });

export type TestCustomer = z.infer<typeof testCustomerSchema>;

export const testCustomerListQuerySchema = cursorQuerySchema.meta({ id: 'TestCustomerListQuery' });

export const testCustomerPageSchema = cursorPageSchema(testCustomerSchema, 'TestCustomerPage');

export type TestCustomerPage = z.infer<typeof testCustomerPageSchema>;

/** `POST /api/admin/test-customers` (rule T1). */
export const createTestCustomerSchema = z
  .object({ name: fullNameSchema, email: z.email().max(254), phone: phoneSchema })
  .meta({ id: 'CreateTestCustomer' });

export type CreateTestCustomer = z.input<typeof createTestCustomerSchema>;

/** A generated password, shown once (rules T1, T2). */
export const generatedPasswordSchema = z
  .object({ password: z.string() })
  .meta({ id: 'GeneratedPassword' });

export type GeneratedPassword = z.infer<typeof generatedPasswordSchema>;

/** A new test customer with its password, shown once (rule T1). */
export const createdTestCustomerSchema = testCustomerSchema
  .extend(generatedPasswordSchema.shape)
  .meta({ id: 'CreatedTestCustomer' });

export type CreatedTestCustomer = z.infer<typeof createdTestCustomerSchema>;

/* Search (rule CS1) ----------------------------------------------------------------------- */

/** The list's status tabs: the statuses, and test customers only. */
export const CUSTOMER_FILTERS = ['all', 'active', 'frozen', 'archived', 'test'] as const;

export const customerFilterSchema = z.enum(CUSTOMER_FILTERS).meta({ id: 'CustomerFilter' });

export type CustomerFilter = z.infer<typeof customerFilterSchema>;

/** `GET /api/admin/customers`: newest first, 25 a page. */
export const customerSearchQuerySchema = cursorQuerySchema
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    status: customerFilterSchema.default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .meta({ id: 'CustomerSearchQuery' });

export type CustomerSearchQuery = z.infer<typeof customerSearchQuerySchema>;

/** What a search text means (CS1), in this order of precedence. */
export type CustomerSearch =
  | { kind: 'order'; number: string }
  | { kind: 'deposit'; referenceCode: string }
  | { kind: 'ticket'; number: string }
  | { kind: 'email'; prefix: string }
  /** `e164` when the number parses (exact match), else the typed digits (suffix match). */
  | { kind: 'phone'; e164: string | null; digits: string }
  | { kind: 'text'; text: string };

const PHONE_TEXT = /^[\d\s+]+$/;
const MIN_PHONE_DIGITS = 6;

/** Rule CS1: an order, deposit or ticket number, an email, a phone, or a name or email part. */
export function classifyCustomerSearch(query: string): CustomerSearch {
  const text = query.trim();
  const order = /^vo-?/i.test(text) ? orderNumberSchema.safeParse(text) : null;
  if (order?.success) return { kind: 'order', number: order.data };
  const deposit = /^vd-?/i.test(text) ? referenceCodeSchema.safeParse(text) : null;
  if (deposit?.success) return { kind: 'deposit', referenceCode: deposit.data };
  const ticket = /^vt-?/i.test(text) ? ticketNumberSchema.safeParse(text) : null;
  if (ticket?.success) return { kind: 'ticket', number: ticket.data };
  if (text.includes('@')) return { kind: 'email', prefix: text.toLowerCase() };
  const digits = text.replace(/\D/g, '');
  if (PHONE_TEXT.test(text) && digits.length >= MIN_PHONE_DIGITS) {
    const phone = phoneSchema.safeParse(text);
    return { kind: 'phone', e164: phone.success ? phone.data : null, digits };
  }
  return { kind: 'text', text };
}

/** One row of `/customers` (CS2). */
export const adminCustomerRowSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    isTest: z.boolean(),
    status: customerStatusSchema,
    createdAt: z.iso.datetime(),
    balanceUnits: amountUnitsSchema,
    deliveredOrders: z.int().nonnegative(),
    lastOrderAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AdminCustomerRow' });

export type AdminCustomerRow = z.infer<typeof adminCustomerRowSchema>;

export const adminCustomerPageSchema = cursorPageSchema(
  adminCustomerRowSchema,
  'AdminCustomerPage',
);

export type AdminCustomerPage = z.infer<typeof adminCustomerPageSchema>;

/* Limits (rules LM1–LM6) ------------------------------------------------------------------ */

/** At most $100,000 for any override (S12 data). */
export const CUSTOMER_LIMIT_MAX_USD_UNITS = 100_000 * 1_000_000;

/** An override: positive whole cents up to $100,000. */
export const customerLimitValueSchema = z
  .int()
  .min(USD_CENT)
  .max(CUSTOMER_LIMIT_MAX_USD_UNITS)
  .refine(isWholeCents, 'Expected whole cents');

/** The stored overrides; null means the store default (the tier, or no purchase cap). */
export interface CustomerLimitOverrides {
  perDepositUsdUnits: number | null;
  dailyDepositUsdUnits: number | null;
  dailyPurchaseUsdUnits: number | null;
}

/** A customer without a `customer_limits` row. */
export const NO_LIMIT_OVERRIDES: CustomerLimitOverrides = {
  perDepositUsdUnits: null,
  dailyDepositUsdUnits: null,
  dailyPurchaseUsdUnits: null,
};

/**
 * Rule LM2: the deposit limit settings with the customer's overrides in place of both tiers'
 * per-deposit and daily values; the minimum is unchanged.
 */
export function effectiveDepositLimitSettings<Settings extends DepositLimitSettings>(
  settings: Settings,
  overrides: Pick<CustomerLimitOverrides, 'perDepositUsdUnits' | 'dailyDepositUsdUnits'>,
): Settings {
  const perDeposit = overrides.perDepositUsdUnits;
  const daily = overrides.dailyDepositUsdUnits;
  return {
    ...settings,
    newAccountPerDepositUsdUnits: perDeposit ?? settings.newAccountPerDepositUsdUnits,
    establishedPerDepositUsdUnits: perDeposit ?? settings.establishedPerDepositUsdUnits,
    newAccountDailyUsdUnits: daily ?? settings.newAccountDailyUsdUnits,
    establishedDailyUsdUnits: daily ?? settings.establishedDailyUsdUnits,
  };
}

/** `PURCHASE_LIMIT_EXCEEDED`'s `details` (rule LM4). */
export interface PurchaseCapBreach {
  limitUnits: number;
  remainingUnits: number;
}

/**
 * Rule LM4: whether a purchase of `newUnits` breaks a daily cap, given what the customer bought in
 * the last 24 hours (net of refunds). Null when there is no cap or it fits.
 */
export function purchaseCapBreach(
  capUnits: number | null,
  usedUnits: number,
  newUnits: number,
): PurchaseCapBreach | null {
  if (capUnits === null || usedUnits + newUnits <= capUnits) return null;
  return { limitUnits: capUnits, remainingUnits: Math.max(0, capUnits - usedUnits) };
}

/** Where a limit's value comes from (LM3): a tier's default, the override, or no cap. */
export const CUSTOMER_LIMIT_SOURCES = [
  'default_new',
  'default_established',
  'custom',
  'none',
] as const;

export const customerLimitSourceSchema = z
  .enum(CUSTOMER_LIMIT_SOURCES)
  .meta({ id: 'CustomerLimitSource' });

export type CustomerLimitSource = z.infer<typeof customerLimitSourceSchema>;

const effectiveLimit = z.object({
  /** Null only for a purchase cap that is not set. */
  units: amountUnitsSchema.nullable(),
  source: customerLimitSourceSchema,
});

export type EffectiveLimit = z.infer<typeof effectiveLimit>;

/** A customer's overrides and the limits in force (LM3); `PUT …/limits` answers it. */
export const customerLimitsSchema = z
  .object({
    perDepositUsdUnits: amountUnitsSchema.nullable(),
    dailyDepositUsdUnits: amountUnitsSchema.nullable(),
    dailyPurchaseUsdUnits: amountUnitsSchema.nullable(),
    effective: z.object({
      perDeposit: effectiveLimit,
      dailyDeposit: effectiveLimit,
      dailyPurchase: effectiveLimit,
    }),
  })
  .meta({ id: 'CustomerLimits' });

export type CustomerLimits = z.infer<typeof customerLimitsSchema>;

/** Rule LM3: the overrides and, for each limit, its value in force and where it comes from. */
export function customerLimits(
  settings: DepositLimitSettings,
  established: boolean,
  overrides: CustomerLimitOverrides,
): CustomerLimits {
  const tier: CustomerLimitSource = established ? 'default_established' : 'default_new';
  const pick = (override: number | null, fallback: number): EffectiveLimit =>
    override === null ? { units: fallback, source: tier } : { units: override, source: 'custom' };
  const cap = overrides.dailyPurchaseUsdUnits;
  return {
    ...overrides,
    effective: {
      perDeposit: pick(
        overrides.perDepositUsdUnits,
        established
          ? settings.establishedPerDepositUsdUnits
          : settings.newAccountPerDepositUsdUnits,
      ),
      dailyDeposit: pick(
        overrides.dailyDepositUsdUnits,
        established ? settings.establishedDailyUsdUnits : settings.newAccountDailyUsdUnits,
      ),
      dailyPurchase:
        cap === null ? { units: null, source: 'none' } : { units: cap, source: 'custom' },
    },
  };
}

/** The reason every state and limit change carries, 5 to 500 characters (CF1, LM5, AR1, SN1). */
export const customerChangeReasonSchema = z.string().trim().min(5).max(500);

/** `PUT /api/admin/customers/:id/limits` (LM5): null clears an override. */
export const updateCustomerLimitsSchema = z
  .object({
    perDepositUsdUnits: customerLimitValueSchema.nullable(),
    dailyDepositUsdUnits: customerLimitValueSchema.nullable(),
    dailyPurchaseUsdUnits: customerLimitValueSchema.nullable(),
    reason: customerChangeReasonSchema,
  })
  .refine(
    (value) =>
      value.perDepositUsdUnits === null ||
      value.dailyDepositUsdUnits === null ||
      value.perDepositUsdUnits <= value.dailyDepositUsdUnits,
    { path: ['dailyDepositUsdUnits'], message: 'Below the per-deposit limit' },
  )
  .meta({ id: 'UpdateCustomerLimits' });

export type UpdateCustomerLimits = z.infer<typeof updateCustomerLimitsSchema>;

/* State changes (CF, AR, SN1) ------------------------------------------------------------- */

/** Freeze, unfreeze, archive, unarchive and sign out everywhere. */
export const customerStateChangeSchema = z
  .object({ reason: customerChangeReasonSchema })
  .meta({ id: 'CustomerStateChange' });

export type CustomerStateChange = z.infer<typeof customerStateChangeSchema>;

/** `CUSTOMER_NOT_ARCHIVABLE`'s `details.blockers` (rule AR1). */
export const ARCHIVE_BLOCKERS = ['balance', 'open_orders', 'open_deposits'] as const;

export type ArchiveBlocker = (typeof ARCHIVE_BLOCKERS)[number];

/* Notes (rule SN2) ------------------------------------------------------------------------ */

export const customerNoteSchema = z
  .object({
    id: z.uuid(),
    body: z.string(),
    pinned: z.boolean(),
    createdAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'CustomerNote' });

export type CustomerNote = z.infer<typeof customerNoteSchema>;

export const createCustomerNoteSchema = z
  .object({
    body: z
      .string()
      .transform((value) => value.replace(/\r\n?/g, '\n').trim())
      .pipe(
        z
          .string()
          .min(1)
          .max(2000)
          .regex(/^(?:[^\p{Cc}]|\n)+$/u),
      ),
    pinned: z.boolean().default(false),
  })
  .meta({ id: 'CreateCustomerNote' });

export type CreateCustomerNote = z.input<typeof createCustomerNoteSchema>;

/** `GET …/notes`: newest first; archived notes only when asked ("عرض المؤرشفة"). */
export const customerNoteListQuerySchema = cursorQuerySchema
  .extend({ archived: z.stringbool().default(false) })
  .meta({ id: 'CustomerNoteListQuery' });

export type CustomerNoteListQuery = z.infer<typeof customerNoteListQuerySchema>;

export const customerNotePageSchema = cursorPageSchema(customerNoteSchema, 'CustomerNotePage');

export type CustomerNotePage = z.infer<typeof customerNotePageSchema>;

/* Devices (CS4) and signals (CS5) --------------------------------------------------------- */

/** One row of the sign-in log; the panel describes the user agent. */
export const customerSignInSchema = z
  .object({
    id: z.uuid(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'CustomerSignIn' });

export type CustomerSignIn = z.infer<typeof customerSignInSchema>;

export const customerSignInPageSchema = cursorPageSchema(
  customerSignInSchema,
  'CustomerSignInPage',
);

export type CustomerSignInPage = z.infer<typeof customerSignInPageSchema>;

/** One active session of the customer. */
export const customerSessionSchema = z
  .object({
    id: z.uuid(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lastActiveAt: z.iso.datetime(),
  })
  .meta({ id: 'CustomerSession' });

export type CustomerSession = z.infer<typeof customerSessionSchema>;

export const customerSessionListSchema = z
  .array(customerSessionSchema)
  .meta({ id: 'CustomerSessionList' });

/** Sign-ins are kept this long (S12 data). */
export const SIGN_IN_RETENTION_DAYS = 90;

/** CS5: at most this many other customers are listed per signal. */
export const SIGNAL_LIST_MAX = 10;

/** CS5: the window of sign-ins the shared-IP signal compares. */
export const SHARED_IP_WINDOW_DAYS = 30;

const otherCustomer = { id: z.uuid(), name: z.string(), email: z.string() };

/** Rule CS5: shown, never acted on automatically. */
export const customerSignalsSchema = z
  .object({
    sharedPhone: z.object({
      count: z.int().nonnegative(),
      customers: z.array(z.object(otherCustomer)),
    }),
    sharedIp: z.object({
      count: z.int().nonnegative(),
      customers: z.array(z.object({ ...otherCustomer, ipAddresses: z.array(z.string()) })),
    }),
  })
  .meta({ id: 'CustomerSignals' });

export type CustomerSignals = z.infer<typeof customerSignalsSchema>;

/* Profile (rule CS3) ---------------------------------------------------------------------- */

/** `GET /api/admin/customers/:id` and the answer of every state change. */
export const adminCustomerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    emailVerified: z.boolean(),
    isTest: z.boolean(),
    createdAt: z.iso.datetime(),
    /** S03 SC3: one credited deposit. */
    established: z.boolean(),
    status: customerStatusSchema,
    /** The last freeze or archive while the customer is in that state, from the audit log. */
    statusChange: z.object({ reason: z.string().nullable(), at: z.iso.datetime() }).nullable(),
    limits: customerLimitsSchema,
    pinnedNote: customerNoteSchema.nullable(),
    balanceUnits: amountUnitsSchema,
    counts: z.object({
      deliveredOrders: z.int().nonnegative(),
      deliveredTotalUsdUnits: amountUnitsSchema,
      refundedOrders: z.int().nonnegative(),
      creditedDeposits: z.int().nonnegative(),
      creditedTotalUsdUnits: amountUnitsSchema,
      openTickets: z.int().nonnegative(),
      activeSessions: z.int().nonnegative(),
      /** What a freeze would cancel (CF1). */
      reservations: z.int().nonnegative(),
      /** S15: the devices with push on. */
      pushDevices: z.int().nonnegative(),
    }),
    signals: customerSignalsSchema,
    /** S14 TA3: the versions in force at sign-up; null before the page was published. */
    termsVersion: acceptedVersionSchema.nullable(),
    privacyVersion: acceptedVersionSchema.nullable(),
  })
  .meta({ id: 'AdminCustomer' });

export type AdminCustomer = z.infer<typeof adminCustomerSchema>;
