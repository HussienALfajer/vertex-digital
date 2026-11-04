import { z } from 'zod';
import { CURRENCY_SCALE, usdCentsSchema } from './money.js';

/*
 * Syrian credit, bills and cash (S25, F44, ADR 0039), owned by the api `orders` module: the
 * recipient number types (RN1), the free-amount products (AM1), the section's service classes
 * and limits (CL1–CL6) and the cash hold (CS1–CS5). Imports only `money`, so the store's buy box
 * stays light.
 */

// Recipient numbers (RN1) ---------------------------------------------------------------------

export const SYRIAN_OPERATORS = ['syriatel', 'mtn'] as const;

export type SyrianOperator = (typeof SYRIAN_OPERATORS)[number];

/** RN1: the prefixes of each operator's lines, after the leading `09`. */
export const OPERATOR_PREFIXES: Readonly<Record<SyrianOperator, readonly string[]>> = {
  syriatel: ['093', '098', '099'],
  mtn: ['094', '095', '096'],
};

/** The field types that hold a recipient line, and their operator (S25 Data). */
export const RECIPIENT_FIELD_TYPES = ['syriatel_number', 'mtn_number'] as const;

export type RecipientFieldType = (typeof RECIPIENT_FIELD_TYPES)[number];

export const RECIPIENT_FIELD_OPERATOR: Readonly<Record<RecipientFieldType, SyrianOperator>> = {
  syriatel_number: 'syriatel',
  mtn_number: 'mtn',
};

/** The refusal of a well-formed line of the other operator (RN1), in `params.reason`. */
export const WRONG_OPERATOR = 'wrong_operator';

/** The most characters a recipient may be typed with (spaces and a `+00963` prefix included). */
export const RECIPIENT_TYPED_MAX = 32;

const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/** Arabic-Indic and Persian digits read as Latin ones. */
function latinDigits(value: string): string {
  return value.replace(ARABIC_INDIC, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

const SYRIAN_MOBILE = /^(?:0|\+963|00963|963)?(9[0-9]{8})$/;

/**
 * RN1: a Syrian mobile number as typed (`09XXXXXXXX`, `9XXXXXXXX`, `+9639XXXXXXXX`,
 * `009639XXXXXXXX`, `9639XXXXXXXX`; spaces and dashes ignored, Arabic-Indic digits read as
 * Latin) as `09XXXXXXXX`, or null when it is none of these.
 */
export function normalizeSyrianMobile(value: string): string | null {
  const compact = latinDigits(value).replace(/[\s-]/g, '');
  const match = SYRIAN_MOBILE.exec(compact);
  return match ? `0${match[1]}` : null;
}

/** RN1: the operator of a normalised number by its prefix, or null for any other prefix. */
export function syrianOperatorOf(normalized: string): SyrianOperator | null {
  const prefix = normalized.slice(0, 3);
  for (const operator of SYRIAN_OPERATORS)
    if (OPERATOR_PREFIXES[operator].includes(prefix)) return operator;
  return null;
}

/**
 * RN1: a recipient line of one operator, normalised to `09XXXXXXXX`. A line of the other operator
 * is refused with `params.reason` `wrong_operator` and `params.operator` naming it.
 */
export function recipientNumberSchema(operator: SyrianOperator): z.ZodType<string, string> {
  return z
    .string()
    .max(RECIPIENT_TYPED_MAX)
    .transform((typed, context) => {
      const normalized = normalizeSyrianMobile(typed);
      const owner = normalized === null ? null : syrianOperatorOf(normalized);
      if (normalized !== null && owner === operator) return normalized;
      context.addIssue(
        owner === null
          ? { code: 'custom', message: 'Expected a Syrian mobile number' }
          : {
              code: 'custom',
              message: 'The number belongs to the other operator',
              params: { reason: WRONG_OPERATOR, operator: owner },
            },
      );
      return z.NEVER;
    });
}

/** RN2: a normalised number grouped for reading, `09X XXX XXXX`. */
export function groupRecipient(normalized: string): string {
  return `${normalized.slice(0, 3)} ${normalized.slice(3, 6)} ${normalized.slice(6)}`;
}

/** CL4: a number in an alert, only its last two digits shown (`09X XXX XX12`). */
export function maskRecipient(normalized: string): string {
  return `09X XXX XX${normalized.slice(-2)}`;
}

// Free-amount products (AM1, D12) ---------------------------------------------------------------

/** AM1: one unit of an `amount` product's quantity is this much of its unit (fixed in V1). */
export const AMOUNT_STEP = 100;

/** S25 Data: the most units an `amount` product may set (100,000 of its unit). */
export const MAX_AMOUNT_UNITS = 1_000;

/** S25 Data: the unit an `amount` product is typed in unless the admin names another. */
export const DEFAULT_AMOUNT_UNIT_AR = 'ل.س';

/** AM1: the face amount of a quantity (`7,300` for 73 units of 100). */
export function amountOfQuantity(quantity: number, step: number = AMOUNT_STEP): number {
  return quantity * step;
}

/**
 * AM1: the quantity of a typed face amount, or null when it is not a whole number of steps
 * within `minQuantity × step` and `maxQuantity × step`.
 */
export function quantityOfAmount(
  amount: number,
  bounds: { minQuantity: number; maxQuantity: number; step?: number },
): number | null {
  const step = bounds.step ?? AMOUNT_STEP;
  if (!Number.isSafeInteger(amount) || amount % step !== 0) return null;
  const quantity = amount / step;
  return quantity >= bounds.minQuantity && quantity <= bounds.maxQuantity ? quantity : null;
}

// Service classes (CL1) -----------------------------------------------------------------------

/** CL1: `credit` (credit and bills) and `cash` games form the section; `none` is every other. */
export const SERVICE_CLASSES = ['none', 'credit', 'cash'] as const;

export const serviceClassSchema = z.enum(SERVICE_CLASSES).meta({ id: 'ServiceClass' });

export type ServiceClass = z.infer<typeof serviceClassSchema>;

/** `PUT /api/admin/catalog/games/:id/service-class`. */
export const serviceClassInputSchema = z
  .object({ serviceClass: serviceClassSchema })
  .meta({ id: 'ServiceClassInput' });

export type ServiceClassInput = z.infer<typeof serviceClassInputSchema>;

/** CL1: the game is in the "الرصيد والفواتير" section. */
export function inCreditSection(serviceClass: ServiceClass): boolean {
  return serviceClass !== 'none';
}

// Credit policy (S25 Data) --------------------------------------------------------------------

const MAX_POLICY_USD_UNITS = 100_000 * CURRENCY_SCALE.USD;

const policyUsd = usdCentsSchema.min(0).max(MAX_POLICY_USD_UNITS);
const policyCount = z.int().min(0).max(1_000);
const policyHours = z.int().min(0).max(720);

/** The single-row credit policy (`GET`/`PUT /api/admin/credit-policy`), amounts in USD units. */
export const creditPolicySchema = z
  .object({
    /** CL2: the section's 24-hour cap per customer. */
    retailDailyUsdUnits: policyUsd,
    merchantDailyUsdUnits: policyUsd,
    /** CL3: orders to one number in 24 hours, from every account. */
    recipientDailyOrdersRetail: policyCount,
    recipientDailyOrdersMerchant: policyCount,
    /** CL4: alert when a number gets orders from more accounts than this within the days. */
    recipientAccountsAlert: policyCount,
    recipientAlertDays: z.int().min(1).max(90),
    /** CS2: the cash 24-hour cap per customer. */
    cashRetailDailyUsdUnits: policyUsd,
    cashMerchantDailyUsdUnits: policyUsd,
    /** CS3: a cash order above this is held for the admin's approval. */
    cashRetailApprovalAboveUsdUnits: policyUsd,
    cashMerchantApprovalAboveUsdUnits: policyUsd,
    /** CS1: only balance credited at least this long ago pays a cash order. */
    cashBalanceAgeHours: policyHours,
    /** CS5: an undecided hold is refunded after this long. */
    cashHoldHours: policyHours,
    /** CS4: Telegram may approve up to this total; above it, the panel only. */
    cashTelegramCeilingUsdUnits: policyUsd,
  })
  .meta({ id: 'CreditPolicy' });

export type CreditPolicy = z.infer<typeof creditPolicySchema>;

const usd = (dollars: number) => dollars * CURRENCY_SCALE.USD;

/** The seeded policy (D9, D10). */
export const CREDIT_POLICY_DEFAULTS: CreditPolicy = {
  retailDailyUsdUnits: usd(50),
  merchantDailyUsdUnits: usd(500),
  recipientDailyOrdersRetail: 5,
  recipientDailyOrdersMerchant: 20,
  recipientAccountsAlert: 2,
  recipientAlertDays: 7,
  cashRetailDailyUsdUnits: usd(20),
  cashMerchantDailyUsdUnits: usd(100),
  cashRetailApprovalAboveUsdUnits: usd(10),
  cashMerchantApprovalAboveUsdUnits: usd(50),
  cashBalanceAgeHours: 72,
  cashHoldHours: 24,
  cashTelegramCeilingUsdUnits: usd(50),
};

/** CL2, CL3, CS2: the limits counted over the last 24 rolling hours. */
export const CREDIT_WINDOW_HOURS = 24;

// Limits (CL2, CL3, CS1, CS2) ---------------------------------------------------------------

/** Section and cash totals, spent in the window or added by the new order or checkout. */
export interface SectionAmounts {
  sectionUsdUnits: number;
  cashUsdUnits: number;
}

/** CL3: one recipient's orders in the window, and the new order's or checkout's to it. */
export interface RecipientOrders {
  recipient: string;
  existing: number;
  adding: number;
}

export interface CreditLimitFacts {
  policy: CreditPolicy;
  merchant: boolean;
  spent: SectionAmounts;
  adding: SectionAmounts;
  recipients: readonly RecipientOrders[];
  /** CS1: the wallet balance older than `cashBalanceAgeHours`, read when cash is added. */
  cashEligibleUsdUnits: number;
}

export type CreditLimitRefusal =
  | { code: 'RECIPIENT_DAILY_LIMIT'; recipient: string; limit: number }
  | { code: 'CREDIT_DAILY_LIMIT'; remainingUsdUnits: number }
  | { code: 'CASH_DAILY_LIMIT'; remainingUsdUnits: number }
  | { code: 'CASH_BALANCE_TOO_RECENT'; eligibleUsdUnits: number };

/** The caps of the buyer's kind (D9, D10, S25 edge 11: a merchant's caps for every sale). */
export function creditCaps(
  policy: CreditPolicy,
  merchant: boolean,
): { sectionUsdUnits: number; cashUsdUnits: number; recipientOrders: number } {
  return merchant
    ? {
        sectionUsdUnits: policy.merchantDailyUsdUnits,
        cashUsdUnits: policy.cashMerchantDailyUsdUnits,
        recipientOrders: policy.recipientDailyOrdersMerchant,
      }
    : {
        sectionUsdUnits: policy.retailDailyUsdUnits,
        cashUsdUnits: policy.cashRetailDailyUsdUnits,
        recipientOrders: policy.recipientDailyOrdersRetail,
      };
}

/**
 * The first limit a new order or checkout would break, or null: CL3 per number, then CL2's
 * section cap, then CS2's cash cap, then CS1's balance age (cash only).
 */
export function creditLimitRefusal(facts: CreditLimitFacts): CreditLimitRefusal | null {
  const caps = creditCaps(facts.policy, facts.merchant);
  for (const line of facts.recipients)
    if (line.existing + line.adding > caps.recipientOrders)
      return {
        code: 'RECIPIENT_DAILY_LIMIT',
        recipient: line.recipient,
        limit: caps.recipientOrders,
      };
  const section = remaining(caps.sectionUsdUnits, facts.spent.sectionUsdUnits);
  if (facts.adding.sectionUsdUnits > section)
    return { code: 'CREDIT_DAILY_LIMIT', remainingUsdUnits: section };
  if (facts.adding.cashUsdUnits === 0) return null;
  const cash = remaining(caps.cashUsdUnits, facts.spent.cashUsdUnits);
  if (facts.adding.cashUsdUnits > cash)
    return { code: 'CASH_DAILY_LIMIT', remainingUsdUnits: cash };
  if (facts.adding.cashUsdUnits > facts.cashEligibleUsdUnits)
    return { code: 'CASH_BALANCE_TOO_RECENT', eligibleUsdUnits: facts.cashEligibleUsdUnits };
  return null;
}

function remaining(cap: number, spent: number): number {
  return Math.max(0, cap - spent);
}

/** CS1: the balance a cash order may use: the wallet less what was credited within the age. */
export function cashEligibleBalance(
  balanceUsdUnits: number,
  recentCreditsUsdUnits: number,
): number {
  return remaining(balanceUsdUnits, recentCreditsUsdUnits);
}

/** CS3: a cash order of this total is held for the admin's approval. */
export function cashNeedsApproval(
  policy: CreditPolicy,
  merchant: boolean,
  totalUsdUnits: number,
): boolean {
  const above = merchant
    ? policy.cashMerchantApprovalAboveUsdUnits
    : policy.cashRetailApprovalAboveUsdUnits;
  return totalUsdUnits > above;
}

/** CS4: Telegram may decide a hold of this total; above the ceiling, the panel only. */
export function cashTelegramDecides(policy: CreditPolicy, totalUsdUnits: number): boolean {
  return totalUsdUnits <= policy.cashTelegramCeilingUsdUnits;
}

/**
 * CL4: a number is alerted on when the accounts that ordered to it within the days, the new one
 * included, are more than `recipientAccountsAlert`.
 */
export function recipientNeedsAlert(policy: CreditPolicy, distinctAccounts: number): boolean {
  return distinctAccounts > policy.recipientAccountsAlert;
}

/** `GET /api/credit-limits`: what the signed-in customer may still spend in the section. */
export const creditLimitsSchema = z
  .object({
    sectionRemainingUsdUnits: z.int().nonnegative(),
    cashRemainingUsdUnits: z.int().nonnegative(),
    /** CS1: the balance a cash order may use now. */
    cashEligibleUsdUnits: z.int().nonnegative(),
    /** CS1: when more of the balance becomes eligible; null when none waits. */
    cashEligibleMoreAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'CreditLimits' });

export type CreditLimits = z.infer<typeof creditLimitsSchema>;

/** The customer's remaining amounts (CL2, CS2), the cash one also within the section's. */
export function creditRemaining(
  policy: CreditPolicy,
  merchant: boolean,
  spent: SectionAmounts,
): { sectionUsdUnits: number; cashUsdUnits: number } {
  const caps = creditCaps(policy, merchant);
  const section = remaining(caps.sectionUsdUnits, spent.sectionUsdUnits);
  return {
    sectionUsdUnits: section,
    cashUsdUnits: Math.min(section, remaining(caps.cashUsdUnits, spent.cashUsdUnits)),
  };
}

// Cash hold (CS3–CS5) -------------------------------------------------------------------------

export const CASH_HOLD_STATES = ['held', 'approved', 'rejected', 'expired'] as const;

export const cashHoldStateSchema = z.enum(CASH_HOLD_STATES).meta({ id: 'CashHoldState' });

export type CashHoldState = z.infer<typeof cashHoldStateSchema>;

export const CASH_DECISIONS = ['approve', 'reject'] as const;

/** `POST /api/admin/orders/:id/cash-approval` (CS4). */
export const cashApprovalInputSchema = z
  .object({
    decision: z.enum(CASH_DECISIONS),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
  })
  .meta({ id: 'CashApprovalInput' });

export type CashApprovalInput = z.infer<typeof cashApprovalInputSchema>;

/** CS5: the hold expires this long after the order was paid. */
export function cashHoldExpiresAt(paidAt: Date, policy: Pick<CreditPolicy, 'cashHoldHours'>): Date {
  return new Date(paidAt.getTime() + policy.cashHoldHours * 3_600_000);
}
