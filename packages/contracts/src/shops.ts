import { z } from 'zod';
import { fullNameSchema, passwordSchema, phoneSchema } from './auth.js';
import { contrastRatio } from './catalog.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import {
  CURRENCY_SCALE,
  ceilToStep,
  exchangeRateSchema,
  floorToWholeCents,
  isWholeCents,
  rateChangePercent,
  sypToUsd,
  usdCentsSchema,
  usdToSyp,
} from './money.js';

/*
 * Merchant shops with customer wallets (S26, ADR 0040), owned by the api `shops` module: the shop's
 * states, settings and limits, the shop customer realm, and the merchant's transfers and return
 * requests. Rule ids (SH, ST, CA, WL) are the spec's.
 */

const USD = CURRENCY_SCALE.USD;

// --- States (SH1–SH8) ---

export const SHOP_STATUSES = ['requested', 'active', 'suspended', 'closed', 'rejected'] as const;

export const shopStatusSchema = z.enum(SHOP_STATUSES).meta({ id: 'ShopStatus' });

export type ShopStatus = z.infer<typeof shopStatusSchema>;

/** What moves a shop. `close` is the admin's or the merchant revocation's (SH7). */
export type ShopAction = 'approve' | 'reject' | 'suspend' | 'resume' | 'close';

const SHOP_TRANSITIONS: Record<ShopAction, readonly [readonly ShopStatus[], ShopStatus]> = {
  approve: [['requested'], 'active'],
  reject: [['requested'], 'rejected'],
  suspend: [['active'], 'suspended'],
  resume: [['suspended'], 'active'],
  close: [['active', 'suspended'], 'closed'],
};

/** The shop states table: the status an action leads to, or null (`SHOP_STATE_INVALID`). */
export function shopTransition(status: ShopStatus, action: ShopAction): ShopStatus | null {
  const [from, to] = SHOP_TRANSITIONS[action];
  return from.includes(status) ? to : null;
}

/** SH1: a rejected merchant may request again 7 days after the decision. */
export const SHOP_REQUEST_AGAIN_DAYS = 7;

export function shopRequestAgainAt(decidedAt: Date): Date {
  return new Date(decidedAt.getTime() + SHOP_REQUEST_AGAIN_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * SH6: why a shop is suspended, as the shop shows it ("المتجر متوقف مؤقتاً" with the category); the
 * admin's own note is never shown to customers.
 */
export const SHOP_SUSPEND_REASONS = ['review', 'complaints', 'payments', 'other'] as const;

export const shopSuspendReasonSchema = z
  .enum(SHOP_SUSPEND_REASONS)
  .meta({ id: 'ShopSuspendReason' });

export type ShopSuspendReason = z.infer<typeof shopSuspendReasonSchema>;

// --- Slug (SH2, SH3) ---

/** SH2: words a shop may never take, and the store's top-level routes. */
export const RESERVED_SHOP_SLUGS = [
  'admin',
  'api',
  'vertex',
  'digital',
  'support',
  'help',
  'login',
  'shop',
  'shops',
  'store',
  'about',
  'account',
  'cart',
  'categories',
  'faq',
  'games',
  'merchant',
  'merchant-terms',
  'notifications',
  'offline',
  'orders',
  'privacy',
  'refund',
  'sign-in',
  'sign-up',
  'terms',
  'verify-email',
  'wallet',
  'sitemap',
  'robots',
  'manifest',
  'internal',
] as const;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** SH2: lowercase Latin letters, digits and inner hyphens, 3–30 characters, not reserved. */
export const shopSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(30)
  .regex(SLUG_PATTERN)
  .refine((slug) => !(RESERVED_SHOP_SLUGS as readonly string[]).includes(slug), {
    message: 'SLUG_RESERVED',
  })
  .meta({ id: 'ShopSlug' });

// --- Brand color (ST1) ---

/** The theme backgrounds a brand color must stand out from (`brand/identity.md`, app background). */
export const SHOP_DARK_BACKGROUND = '#031B17';
export const SHOP_LIGHT_BACKGROUND = '#F4F8F7';

/** ST1: the 12 ready colors; each passes `brandColorProblem` (contracts test). */
export const SHOP_BRAND_COLORS = [
  '#1f7a6c',
  '#13738f',
  '#2266b3',
  '#5b6abf',
  '#7a4cb8',
  '#a63f8e',
  '#b83a64',
  '#c0392b',
  '#b8560f',
  '#8a5a2b',
  '#6b7a1a',
  '#2e7d32',
] as const;

export type BrandColorProblem = 'white_text' | 'dark_theme';

/**
 * ST1: why a color cannot be a shop's brand color, or null: white text on it below 4.5:1, or the
 * color below 3:1 against the dark theme's background (the light one follows from the first).
 */
export function brandColorProblem(color: string): BrandColorProblem | null {
  if (contrastRatio(color, '#FFFFFF') < 4.5) return 'white_text';
  if (contrastRatio(color, SHOP_DARK_BACKGROUND) < 3) return 'dark_theme';
  // Against the light background a color dark enough for white text (luminance at most 0.183)
  // always reaches 3:1 (0.98 / 0.233 > 4), so that check never refuses one this one passed.
  return null;
}

export const brandColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/)
  .superRefine((color, context) => {
    if (!/^#[0-9a-f]{6}$/.test(color)) return;
    const problem = brandColorProblem(color);
    if (problem)
      context.addIssue({ code: 'custom', message: `BRAND_COLOR_${problem.toUpperCase()}` });
  })
  .meta({ id: 'ShopBrandColor' });

// --- Announcement (ST5) ---

export const SHOP_ANNOUNCEMENT_MAX = 200;

const LINK_PATTERN =
  /(https?:\/\/|www\.|[^\s@]+@[^\s@]+\.[^\s@]+|\b[a-z0-9-]+\.(com|net|org|me|io|co|sy|app|link|ly|info|xyz|shop|store)\b)/i;

/** ST5: whether the text holds a URL, `www.`, a bare domain or an email address. */
export function hasLink(text: string): boolean {
  return LINK_PATTERN.test(text);
}

/** ST5: plain text of 1–200 characters, no links or emails, no control characters. */
export const shopAnnouncementSchema = z
  .string()
  .trim()
  .min(1)
  .max(SHOP_ANNOUNCEMENT_MAX)
  .regex(/^[^\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/u)
  .refine((text) => !hasLink(text), { message: 'ANNOUNCEMENT_HAS_LINK' });

// --- Exchange rate (ST3) ---

export const SHOP_RATE_MODES = ['store', 'own'] as const;

export const shopRateModeSchema = z.enum(SHOP_RATE_MODES).meta({ id: 'ShopRateMode' });

export type ShopRateMode = z.infer<typeof shopRateModeSchema>;

/** ST3: a rate more than this many percent from the store's rate needs a typed confirmation. */
export const SHOP_RATE_FAR_PERCENT = 10;

/** ST3: whether `rate` is more than 10% from `storeRate`, either way; false without a store rate. */
export function shopRateIsFar(storeRate: string | null, rate: string): boolean {
  if (storeRate === null) return false;
  const percent = rateChangePercent(storeRate, rate);
  const magnitude = percent.startsWith('-') ? percent.slice(1) : percent;
  const [whole, hundredths] = magnitude.split('.') as [string, string];
  return Number(whole) * 100 + Number(hundredths) > SHOP_RATE_FAR_PERCENT * 100;
}

/** ST3: the shop's rate in force: its own newest rate, or the store's (null when the store has none). */
export function shopRate(
  mode: ShopRateMode,
  ownRate: string | null,
  storeRate: string | null,
): string | null {
  return mode === 'own' && ownRate !== null ? ownRate : storeRate;
}

// --- Limits (SH8) ---

export const SHOP_DEFAULT_LIMITS = {
  customerBalanceCapUsdUnits: 200 * USD,
  dailyTransferCapUsdUnits: 1_000 * USD,
  customerLimit: 2_000,
} as const;

const capBetween = (min: number, max: number) =>
  usdCentsSchema.refine((units) => units >= min * USD && units <= max * USD, {
    message: `Expected between ${min} and ${max} USD`,
  });

/** SH8: the admin's per-shop limits. */
export const shopLimitsSchema = z
  .object({
    customerBalanceCapUsdUnits: capBetween(1, 5_000),
    dailyTransferCapUsdUnits: capBetween(10, 50_000),
    customerLimit: z.int().min(1).max(20_000),
  })
  .meta({ id: 'ShopLimits' });

export type ShopLimits = z.infer<typeof shopLimitsSchema>;

/** ST6: at most this many hidden games. */
export const SHOP_HIDDEN_GAMES_MAX = 2_000;

// --- Transfers and returns (WL1–WL9) ---

/** WL2: the smallest transfer. */
export const SHOP_TRANSFER_MIN_USD_UNITS = USD / 10;

/** WL4: a transfer needs a password or passkey check within this many seconds. */
export const SHOP_TRANSFER_CHECK_SECONDS = 15 * 60;

/** WL5: a return request expires after 24 hours. */
export const SHOP_RETURN_REQUEST_HOURS = 24;

export const SHOP_TRANSFER_CURRENCIES = ['usd', 'syp'] as const;

export const shopTransferCurrencySchema = z
  .enum(SHOP_TRANSFER_CURRENCIES)
  .meta({ id: 'ShopTransferCurrency' });

export type ShopTransferCurrency = z.infer<typeof shopTransferCurrencySchema>;

export const SHOP_TRANSFER_DIRECTIONS = ['to_customer', 'to_merchant'] as const;

export const shopTransferDirectionSchema = z
  .enum(SHOP_TRANSFER_DIRECTIONS)
  .meta({ id: 'ShopTransferDirection' });

/**
 * WL2: the USD a transfer credits: USD entered as is (whole cents), SYP (whole pounds) ÷ the
 * shop's rate rounded **down** to whole cents. Null when the entry is not valid (sub-cent USD,
 * fractional pounds, SYP without a rate).
 */
export function shopTransferUsd(
  currency: ShopTransferCurrency,
  amountUnits: number,
  rate: string | null,
): number | null {
  if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) return null;
  if (currency === 'usd') return isWholeCents(amountUnits) ? amountUnits : null;
  if (rate === null || amountUnits % CURRENCY_SCALE.SYP !== 0) return null;
  return floorToWholeCents(sypToUsd(amountUnits, rate, 'down'));
}

/**
 * S26 screens ("top up the gap"): the whole pounds to ask the merchant for, so that the transfer
 * of those pounds (WL2, rounded **down** to whole cents) covers `shortfallUsdUnits`: the USD × rate
 * rounded **up** to whole pounds. Those pounds ÷ the rate are at least the shortfall, a whole-cent
 * amount, so the transfer's rounding down never takes it below (the test checks it).
 */
export function shopTopUpSyp(shortfallUsdUnits: number, rate: string): number {
  return ceilToStep(usdToSyp(shortfallUsdUnits, rate, 'up'), CURRENCY_SCALE.SYP);
}

export type ShopTransferRefusal =
  | { code: 'VALIDATION_FAILED' }
  | { code: 'INSUFFICIENT_BALANCE' }
  | { code: 'SHOP_BALANCE_CAP_EXCEEDED'; largestUsdUnits: number }
  | { code: 'SHOP_DAILY_TRANSFER_CAP_EXCEEDED'; remainingUsdUnits: number };

/** WL2, WL3: why a transfer of `amountUsdUnits` is refused under the locks, or null. */
export function shopTransferRefusal(state: {
  amountUsdUnits: number;
  merchantBalanceUsdUnits: number;
  customerBalanceUsdUnits: number;
  balanceCapUsdUnits: number;
  transferredTodayUsdUnits: number;
  dailyCapUsdUnits: number;
}): ShopTransferRefusal | null {
  if (state.amountUsdUnits < SHOP_TRANSFER_MIN_USD_UNITS) return { code: 'VALIDATION_FAILED' };
  if (state.amountUsdUnits > state.merchantBalanceUsdUnits) return { code: 'INSUFFICIENT_BALANCE' };
  if (state.customerBalanceUsdUnits + state.amountUsdUnits > state.balanceCapUsdUnits) {
    return {
      code: 'SHOP_BALANCE_CAP_EXCEEDED',
      largestUsdUnits: Math.max(0, state.balanceCapUsdUnits - state.customerBalanceUsdUnits),
    };
  }
  if (state.transferredTodayUsdUnits + state.amountUsdUnits > state.dailyCapUsdUnits) {
    return {
      code: 'SHOP_DAILY_TRANSFER_CAP_EXCEEDED',
      remainingUsdUnits: Math.max(0, state.dailyCapUsdUnits - state.transferredTodayUsdUnits),
    };
  }
  return null;
}

export const RETURN_REQUEST_STATUSES = [
  'pending',
  'confirmed',
  'declined',
  'expired',
  'cancelled',
] as const;

export const returnRequestStatusSchema = z
  .enum(RETURN_REQUEST_STATUSES)
  .meta({ id: 'ShopReturnRequestStatus' });

export type ReturnRequestStatus = z.infer<typeof returnRequestStatusSchema>;

/** WL5: how a pending request ends. */
export type ReturnRequestAction = 'confirm' | 'decline' | 'expire' | 'cancel';

const RETURN_REQUEST_ENDS: Record<ReturnRequestAction, ReturnRequestStatus> = {
  confirm: 'confirmed',
  decline: 'declined',
  expire: 'expired',
  cancel: 'cancelled',
};

/** WL5: only a pending request ends, once; null is `RETURN_REQUEST_STATE_INVALID`. */
export function returnRequestTransition(
  status: ReturnRequestStatus,
  action: ReturnRequestAction,
): ReturnRequestStatus | null {
  return status === 'pending' ? RETURN_REQUEST_ENDS[action] : null;
}

/** WL9: where a closed shop's customer balance goes. */
export const SHOP_SETTLEMENT_TARGETS = ['merchant', 'cash_refund'] as const;

export const shopSettlementTargetSchema = z
  .enum(SHOP_SETTLEMENT_TARGETS)
  .meta({ id: 'ShopSettlementTarget' });

export type ShopSettlementTarget = z.infer<typeof shopSettlementTargetSchema>;

// --- Shop customers (CA1–CA9) ---

export const SHOP_CUSTOMER_ORIGINS = ['merchant', 'self'] as const;

export const shopCustomerOriginSchema = z
  .enum(SHOP_CUSTOMER_ORIGINS)
  .meta({ id: 'ShopCustomerOrigin' });

/** CA1: an invitation link lives 72 hours. */
export const SHOP_INVITATION_HOURS = 72;

/** CA1: "إعادة إرسال الدعوة" at most 3 times a Damascus day per customer. */
export const SHOP_INVITATIONS_PER_DAY = 3;

/**
 * How the merchant sees a customer: `invited` (no password set yet), `unverified` (signed up,
 * email not verified), `active`, `frozen` (CA7, without the reason) or `archived` (CA9).
 */
export const SHOP_CUSTOMER_STATES = [
  'invited',
  'unverified',
  'active',
  'frozen',
  'archived',
] as const;

export const shopCustomerStateSchema = z
  .enum(SHOP_CUSTOMER_STATES)
  .meta({ id: 'ShopCustomerState' });

export type ShopCustomerState = z.infer<typeof shopCustomerStateSchema>;

export function shopCustomerState(row: {
  emailVerified: boolean;
  hasPassword: boolean;
  frozenAt: Date | null;
  archivedAt: Date | null;
}): ShopCustomerState {
  if (row.archivedAt) return 'archived';
  if (row.frozenAt) return 'frozen';
  if (!row.hasPassword) return 'invited';
  return row.emailVerified ? 'active' : 'unverified';
}

// --- API shapes: the merchant ---

/** `POST /api/merchant/shop` (SH1, SH2, ST1, ST3). */
export const requestShopSchema = z
  .object({
    slug: shopSlugSchema,
    brandColor: brandColorSchema,
    rateMode: shopRateModeSchema,
    /** Required with `own`. */
    rate: exchangeRateSchema.nullable().default(null),
    confirmFar: z.boolean().default(false),
  })
  .refine((value) => value.rateMode === 'store' || value.rate !== null, {
    path: ['rate'],
    message: 'A rate is required with an own rate',
  })
  .meta({ id: 'RequestShop' });

export type RequestShop = z.input<typeof requestShopSchema>;

/** `PATCH /api/merchant/shop` (ST1, ST3, ST5): the fields to change; `announcement: null` clears it. */
export const shopSettingsSchema = z
  .object({
    brandColor: brandColorSchema,
    announcement: shopAnnouncementSchema.nullable(),
    rateMode: shopRateModeSchema,
    rate: exchangeRateSchema,
    confirmFar: z.boolean(),
  })
  .partial()
  .refine(
    (value) =>
      value.brandColor !== undefined ||
      value.announcement !== undefined ||
      value.rateMode !== undefined ||
      value.rate !== undefined,
    { message: 'Nothing to update' },
  )
  .meta({ id: 'ShopSettings' });

export type ShopSettings = z.input<typeof shopSettingsSchema>;

/** The shop as its merchant sees it (`GET /api/merchant/shop`). */
export const merchantShopSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    status: shopStatusSchema,
    displayName: z.string(),
    brandColor: z.string(),
    announcement: z.string().nullable(),
    rateMode: shopRateModeSchema,
    /** The newest own rate, kept when the mode is `store`. */
    ownRate: z.string().nullable(),
    /** The rate in force (ST3); null when it follows a store with no rate. */
    rate: z.string().nullable(),
    limits: shopLimitsSchema,
    transferredTodayUsdUnits: z.int().nonnegative(),
    customerCount: z.int().nonnegative(),
    rejectReason: z.string().nullable(),
    suspendReason: shopSuspendReasonSchema.nullable(),
    requestedAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    /** SH1: when a rejected merchant may request again. */
    requestAgainAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MerchantShop' });

export type MerchantShop = z.infer<typeof merchantShopSchema>;

/** `GET /api/merchant/shop`: the merchant's shop, or null before a request. */
export const merchantShopStateSchema = z
  .object({ shop: merchantShopSchema.nullable() })
  .meta({ id: 'MerchantShopState' });

export type MerchantShopState = z.infer<typeof merchantShopStateSchema>;

/** `GET /api/merchant/shop/slug-available?slug=` (the request form's live check). */
export const slugAvailabilityQuerySchema = z.object({ slug: z.string().max(60) });

export const slugAvailabilitySchema = z
  .object({ available: z.boolean() })
  .meta({ id: 'ShopSlugAvailability' });

/** `PUT /api/merchant/shop/hidden-games` (ST6). */
export const shopHiddenGamesSchema = z
  .object({ gameIds: z.array(z.uuid()).max(SHOP_HIDDEN_GAMES_MAX) })
  .meta({ id: 'ShopHiddenGames' });

export type ShopHiddenGames = z.infer<typeof shopHiddenGamesSchema>;

/** `POST /api/merchant/shop/customers` (CA1). */
export const createShopCustomerSchema = z
  .object({ name: fullNameSchema, email: z.email().max(254), phone: phoneSchema })
  .meta({ id: 'CreateShopCustomer' });

export type CreateShopCustomer = z.input<typeof createShopCustomerSchema>;

/** `PATCH /api/merchant/shop/customers/:id` (CA8): name and phone. */
export const updateShopCustomerSchema = z
  .object({ name: fullNameSchema, phone: phoneSchema })
  .partial()
  .refine((value) => value.name !== undefined || value.phone !== undefined, {
    message: 'Nothing to update',
  })
  .meta({ id: 'UpdateShopCustomer' });

export type UpdateShopCustomer = z.input<typeof updateShopCustomerSchema>;

/** A shop customer as the merchant sees them (TK4: name, email, phone). */
export const shopCustomerRowSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    state: shopCustomerStateSchema,
    origin: shopCustomerOriginSchema,
    balanceUsdUnits: z.int().nonnegative(),
    pendingReturn: z
      .object({ id: z.uuid(), amountUsdUnits: z.int().positive(), expiresAt: z.iso.datetime() })
      .nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ShopCustomerRow' });

export type ShopCustomerRow = z.infer<typeof shopCustomerRowSchema>;

export const shopCustomerQuerySchema = cursorQuerySchema
  .extend({ q: z.string().trim().max(100).optional() })
  .meta({ id: 'ShopCustomerQuery' });

export type ShopCustomerQuery = z.infer<typeof shopCustomerQuerySchema>;

export const shopCustomerPageSchema = cursorPageSchema(shopCustomerRowSchema, 'ShopCustomerPage');

export type ShopCustomerPage = z.infer<typeof shopCustomerPageSchema>;

/** `POST /api/merchant/shop/transfer-check` (WL4): the merchant's password opens 15 minutes. */
export const shopTransferCheckSchema = z
  .object({ password: z.string().min(1).max(128) })
  .meta({ id: 'ShopTransferCheck' });

export const shopTransferCheckResultSchema = z
  .object({ checkedUntil: z.iso.datetime() })
  .meta({ id: 'ShopTransferCheckResult' });

/**
 * `POST /api/merchant/shop/customers/:id/transfers` (WL1–WL4): the amount as entered and the USD
 * the screen showed; another USD at the current rate is `PRICE_CHANGED`.
 */
export const shopTransferSchema = z
  .object({
    currency: shopTransferCurrencySchema,
    amountUnits: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedUsdUnits: usdCentsSchema,
  })
  .meta({ id: 'ShopTransfer' });

export type ShopTransfer = z.infer<typeof shopTransferSchema>;

export const shopTransferResultSchema = z
  .object({
    id: z.uuid(),
    amountUsdUnits: z.int().positive(),
    enteredCurrency: shopTransferCurrencySchema,
    enteredAmountUnits: z.int().positive(),
    rate: z.string().nullable(),
    customerBalanceUsdUnits: z.int().nonnegative(),
    merchantBalanceUsdUnits: z.int().nonnegative(),
    transferredTodayUsdUnits: z.int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ShopTransferResult' });

export type ShopTransferResult = z.infer<typeof shopTransferResultSchema>;

/** `POST /api/merchant/shop/customers/:id/return-requests` (WL5). */
export const createReturnRequestSchema = z
  .object({ amountUsdUnits: usdCentsSchema.refine((units) => units > 0, 'Expected above 0') })
  .meta({ id: 'CreateShopReturnRequest' });

export const returnRequestSchema = z
  .object({
    id: z.uuid(),
    amountUsdUnits: z.int().positive(),
    status: returnRequestStatusSchema,
    expiresAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ShopReturnRequest' });

export type ReturnRequest = z.infer<typeof returnRequestSchema>;

// --- API shapes: the admin ---

/** `POST /api/admin/shops/:id/approve` (SH3, SH8): the slug may be edited before approving. */
export const approveShopSchema = z
  .object({ slug: shopSlugSchema.optional(), limits: shopLimitsSchema })
  .meta({ id: 'ApproveShop' });

export type ApproveShop = z.input<typeof approveShopSchema>;

export const shopReasonSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'ShopReason' });

/** `POST /api/admin/shops/:id/suspend` (SH6): the category the shop shows and the admin's note. */
export const suspendShopSchema = z
  .object({ reason: shopSuspendReasonSchema, note: z.string().trim().min(3).max(500) })
  .meta({ id: 'SuspendShop' });

/** `PATCH /api/admin/shops/:id` (SH3, SH8, ST5): limits, the slug, clearing the announcement. */
export const updateShopSchema = z
  .object({
    limits: shopLimitsSchema,
    slug: shopSlugSchema,
    clearAnnouncement: z.literal(true),
    reason: z.string().trim().min(3).max(500),
  })
  .partial({ limits: true, slug: true, clearAnnouncement: true })
  .refine(
    (value) =>
      value.limits !== undefined ||
      value.slug !== undefined ||
      value.clearAnnouncement !== undefined,
    { message: 'Nothing to update' },
  )
  .meta({ id: 'UpdateShop' });

export type UpdateShop = z.input<typeof updateShopSchema>;

/** `POST /api/admin/shops/:id/customers/:cid/settle` (WL9). */
export const settleShopCustomerSchema = z
  .object({ to: shopSettlementTargetSchema, reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'SettleShopCustomer' });

export type SettleShopCustomer = z.infer<typeof settleShopCustomerSchema>;

export const shopSettlementSchema = z
  .object({
    shopCustomerId: z.uuid(),
    to: shopSettlementTargetSchema,
    amountUsdUnits: z.int().nonnegative(),
    journalId: z.uuid().nullable(),
  })
  .meta({ id: 'ShopSettlement' });

/** A shop in the admin's list (`GET /api/admin/shops`). */
export const adminShopRowSchema = z
  .object({
    id: z.uuid(),
    merchantId: z.uuid(),
    merchantName: z.string(),
    tradeName: z.string(),
    slug: z.string(),
    status: shopStatusSchema,
    brandColor: z.string(),
    customerCount: z.int().nonnegative(),
    totalBalanceUsdUnits: z.int().nonnegative(),
    /** The open shop orders' margins held in `shop_margin_held:USD`. */
    heldMarginUsdUnits: z.int().nonnegative(),
    transferredTodayUsdUnits: z.int().nonnegative(),
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminShopRow' });

export type AdminShopRow = z.infer<typeof adminShopRowSchema>;

export const adminShopQuerySchema = cursorQuerySchema
  .extend({ status: shopStatusSchema.optional(), q: z.string().trim().max(100).optional() })
  .meta({ id: 'AdminShopQuery' });

export type AdminShopQuery = z.infer<typeof adminShopQuerySchema>;

export const adminShopPageSchema = cursorPageSchema(adminShopRowSchema, 'AdminShopPage');

export const adminShopRateSchema = z
  .object({ rate: z.string(), confirmedFar: z.boolean(), createdAt: z.iso.datetime() })
  .meta({ id: 'AdminShopRate' });

/** One shop as the admin sees it (`GET /api/admin/shops/:id`). */
export const adminShopSchema = merchantShopSchema
  .extend({
    merchantId: z.uuid(),
    merchantName: z.string(),
    suspendNote: z.string().nullable(),
    closedAt: z.iso.datetime().nullable(),
    totalBalanceUsdUnits: z.int().nonnegative(),
    heldMarginUsdUnits: z.int().nonnegative(),
    openOrders: z.int().nonnegative(),
    /** WL9: closed, every balance zero and no open order. */
    settled: z.boolean(),
    oldSlugs: z.array(z.string()),
    rates: z.array(adminShopRateSchema),
  })
  .meta({ id: 'AdminShop' });

export type AdminShop = z.infer<typeof adminShopSchema>;

export const adminShopCustomerRowSchema = shopCustomerRowSchema
  .extend({ frozenReason: z.string().nullable() })
  .meta({ id: 'AdminShopCustomerRow' });

export const adminShopCustomerPageSchema = cursorPageSchema(
  adminShopCustomerRowSchema,
  'AdminShopCustomerPage',
);

// --- API shapes: the shop customer ---

/** `POST /api/shops/:slug/auth/sign-up` (CA2): S01's fields and the shop terms. */
export const shopSignUpSchema = z
  .object({
    name: fullNameSchema,
    email: z.email().max(254),
    password: passwordSchema,
    phone: phoneSchema,
    acceptTerms: z.literal(true),
  })
  .meta({ id: 'ShopSignUp' });

export type ShopSignUp = z.input<typeof shopSignUpSchema>;

/** `POST /api/shops/:slug/auth/invitation` (CA1): the link's token and the new password. */
export const acceptShopInvitationSchema = z
  .object({ token: z.string().min(20).max(200), password: passwordSchema })
  .meta({ id: 'AcceptShopInvitation' });

/** `GET /api/shops/:slug/me`. */
export const shopCustomerProfileSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    frozen: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ShopCustomerProfile' });

export type ShopCustomerProfile = z.infer<typeof shopCustomerProfileSchema>;

/** `GET /api/shops/:slug/wallet`: the balance, the shop's rate and the pending return request. */
export const shopWalletSchema = z
  .object({
    balanceUsdUnits: z.int().nonnegative(),
    rate: z.string().nullable(),
    pendingReturn: returnRequestSchema.nullable(),
  })
  .meta({ id: 'ShopWallet' });

export type ShopWallet = z.infer<typeof shopWalletSchema>;

/** The kinds of a shop wallet's timeline (S26 screens, "الرصيد"). */
export const SHOP_WALLET_ENTRY_KINDS = [
  'transfer_in',
  'return_out',
  'purchase',
  'refund',
  'compensation',
  'settlement',
  'adjustment',
] as const;

export const shopWalletEntryKindSchema = z
  .enum(SHOP_WALLET_ENTRY_KINDS)
  .meta({ id: 'ShopWalletEntryKind' });

export const shopWalletEntrySchema = z
  .object({
    id: z.uuid(),
    kind: shopWalletEntryKindSchema,
    amountUnits: z.int(),
    balanceAfterUnits: z.int().nonnegative(),
    orderId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ShopWalletEntry' });

export const shopWalletEntryPageSchema = cursorPageSchema(
  shopWalletEntrySchema,
  'ShopWalletEntryPage',
);

export type ShopWalletEntryPage = z.infer<typeof shopWalletEntryPageSchema>;
