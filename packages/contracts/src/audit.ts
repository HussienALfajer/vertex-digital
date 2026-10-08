import { z } from 'zod';
import {
  depositDeciderSchema,
  depositFlagCodeSchema,
  depositMethodSchema,
  depositReferenceCheckSchema,
  depositRejectReasonSchema,
  usdtCheckErrorSchema,
  usdtTxidSourceSchema,
} from './deposits.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { currencySchema, exchangeRateSchema } from './money.js';
import { displayStepSchema } from './rates.js';
import { storeSwitchSchema } from './settings.js';
import {
  adjustmentCategorySchema,
  adjustmentDirectionSchema,
  manualDepositMethodSchema,
} from './wallet.js';

/*
 * The audit log (ADR 0011, S01 rules A1–A4), owned by the api `audit` module: one append-only
 * entry per money action, admin action, customer account change and CLI run, written in the same
 * transaction as the change. Each spec adds its actions here with the shape of their details.
 */

export const AUDIT_ACTOR_KINDS = ['admin', 'customer', 'system', 'cli'] as const;

export const auditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS).meta({ id: 'AuditActorKind' });

export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

export const AUDIT_CHANNELS = ['admin', 'store', 'telegram', 'worker', 'cli'] as const;

export const auditChannelSchema = z.enum(AUDIT_CHANNELS).meta({ id: 'AuditChannel' });

export type AuditChannel = z.infer<typeof auditChannelSchema>;

export const AUDIT_ENTITY_TYPES = [
  'admin_user',
  'customer',
  'wallet_adjustment',
  'exchange_rate',
  'deposit_settings',
  'deposit',
  'store_switch',
] as const;

export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES).meta({ id: 'AuditEntityType' });

export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;

const none = z.strictObject({});
const count = z.strictObject({ count: z.int().nonnegative() });
const changed = <Shape extends z.ZodRawShape>(shape: Shape) => {
  const values = z.strictObject(shape).partial();
  return z.strictObject({ before: values, after: values });
};
const identity = z.strictObject({ name: z.string(), email: z.string(), phone: z.string() });
const rate = z.strictObject({
  sypPerUsd: exchangeRateSchema,
  displayStepSypUnits: displayStepSchema,
});
const adjustment = {
  customerId: z.uuid(),
  direction: adjustmentDirectionSchema,
  amountUnits: z.int().positive(),
  category: adjustmentCategorySchema,
  customerNote: z.string().nullable(),
  journalId: z.uuid(),
  balanceAfterUnits: z.int().nonnegative(),
};

/** The deposit settings' values in audit details (S03); file ids for the QR images. */
const depositSettingsValues = z
  .strictObject({
    shamCashAccountName: z.string(),
    shamCashAccountNumber: z.string(),
    sypEnabled: z.boolean(),
    usdEnabled: z.boolean(),
    sypQrFileId: z.uuid().nullable(),
    usdQrFileId: z.uuid().nullable(),
    minDepositUsdUnits: z.int(),
    newAccountPerDepositUsdUnits: z.int(),
    newAccountDailyUsdUnits: z.int(),
    establishedPerDepositUsdUnits: z.int(),
    establishedDailyUsdUnits: z.int(),
    reviewHoursStart: z.string(),
    reviewHoursEnd: z.string(),
    reviewTargetMinutes: z.int(),
    flagNewAccountUsdUnits: z.int(),
    flagVelocityCount: z.int(),
    usdtTrc20Enabled: z.boolean(),
    usdtBep20Enabled: z.boolean(),
    usdtMinDepositUsdUnits: z.int(),
  })
  .partial();
const depositQuote = z.strictObject({
  rateId: z.uuid(),
  rate: exchangeRateSchema,
  declaredUsdUnits: z.int().positive(),
});
const flagCodes = z.array(depositFlagCodeSchema);
const deposit = z.strictObject({ depositId: z.uuid() });

/**
 * Every audit action (`<entity>.<verb>`) with the shape of its `details`: before and after of the
 * changed fields, never a password, hash, code, secret, backup code, token or session id (the
 * contract test checks every key). `recordAudit` refuses details that do not match.
 */
export const AUDIT_DETAILS = {
  /** `admin:create` (CLI). */
  'admin.created': z.strictObject({ name: z.string(), email: z.string() }),
  /** `admin:reset-password` (CLI): a new printed password, every session signed out. */
  'admin.password_reset': count,
  /** `admin:reset-two-factor` (CLI): TOTP removed, every session signed out. */
  'admin.two_factor_reset': count,
  /** The TOTP step completed: the session became usable. */
  'admin.signed_in': none,
  /** The admin's own password change; `count` is the other sessions signed out. */
  'admin.password_changed': count,
  'admin.two_factor_enabled': none,
  'admin.backup_codes_regenerated': none,
  /** Sessions of the admin signed out from the account page. */
  'admin.sessions_revoked': count,
  'customer.signed_up': identity,
  'customer.email_verified': z.strictObject({ email: z.string() }),
  'customer.profile_updated': changed({ name: z.string(), phone: z.string() }),
  'customer.email_changed': changed({ email: z.string() }),
  /** `count` is the other sessions signed out (rule C11). */
  'customer.password_changed': count,
  /** By an emailed code (rule C7): every session signed out. */
  'customer.password_reset': none,
  /** Sessions signed out from the account page (rule C14). */
  'customer.sessions_revoked': count,
  'customer.test_created': identity,
  /** `count` is the sessions signed out (rule T2). */
  'customer.test_password_reset': count,
  /** A wallet adjustment by the admin (S02); the internal reason is the entry's `reason`. */
  'wallet_adjustment.created': z.strictObject({
    ...adjustment,
    depositMethod: manualDepositMethodSchema.nullable(),
    externalReference: z.string().nullable(),
  }),
  /** On the reversal's row (rule R1). */
  'wallet_adjustment.reversed': z.strictObject({
    ...adjustment,
    reversedAdjustmentId: z.uuid(),
  }),
  /** A new rate or display step (S03 rule FX1); `before` is null for the first rate. */
  'exchange_rate.changed': z.strictObject({
    rateId: z.uuid(),
    before: rate.nullable(),
    after: rate,
    changePercent: z.string().nullable(),
  }),
  /** A new version of the deposit settings (S03): the changed fields only. */
  'deposit_settings.changed': z.strictObject({
    settingsId: z.uuid(),
    before: depositSettingsValues,
    after: depositSettingsValues,
  }),
  'deposit.created': z.strictObject({
    depositId: z.uuid(),
    method: depositMethodSchema,
    currency: currencySchema,
    declaredAmountUnits: z.int().positive(),
    declaredUsdUnits: z.int().nonnegative(),
    rateId: z.uuid().nullable(),
    /** USDT only: the exact amount to send, tail included (S04 rule U3). */
    payAmountUnits: z.int().positive().optional(),
  }),
  /** A new quote for a SYP deposit (rule SC10). */
  'deposit.requoted': z.strictObject({
    depositId: z.uuid(),
    before: depositQuote,
    after: depositQuote,
  }),
  'deposit.submitted': z.strictObject({
    depositId: z.uuid(),
    receiptId: z.uuid(),
    rateFixed: z.boolean(),
    flags: flagCodes,
  }),
  'deposit.cancelled': deposit,
  /** By the worker (rule SC12). */
  'deposit.expired': deposit,
  /** The internal note is the entry's reason (rule RV7). */
  'deposit.credited': z.strictObject({
    depositId: z.uuid(),
    customerId: z.uuid(),
    transactionNumber: z.string(),
    receivedCurrency: currencySchema,
    receivedAmountUnits: z.int().positive(),
    creditedUsdUnits: z.int().positive(),
    creditRateId: z.uuid().nullable(),
    /** Sham Cash only. */
    referenceCheck: depositReferenceCheckSchema.nullable(),
    /** Null on an exact USDT match, which carries no flags (S04 rule U7). */
    acknowledgedFlags: flagCodes.nullable(),
    decidedBy: depositDeciderSchema,
    journalId: z.uuid(),
    balanceAfterUnits: z.int().nonnegative(),
  }),
  'deposit.rejected': z.strictObject({
    depositId: z.uuid(),
    customerId: z.uuid(),
    rejectReason: depositRejectReasonSchema,
    customerNote: z.string().nullable(),
  }),
  'deposit.receipt_requested': z.strictObject({
    depositId: z.uuid(),
    customerNote: z.string().nullable(),
  }),
  /** S04 rule U8. */
  'deposit.txid_submitted': z.strictObject({ depositId: z.uuid(), txid: z.string() }),
  /** By the worker: a transfer bound to the deposit, to credit or to review (rules U9, U11, U12). */
  'deposit.transfer_bound': z.strictObject({
    depositId: z.uuid(),
    transferId: z.uuid(),
    txid: z.string(),
    source: usdtTxidSourceSchema,
    receivedUnits: z.int().nonnegative(),
    match: z.enum(['exact', 'review']),
    flags: flagCodes,
  }),
  /** By the worker: the TXID failed and the deposit is back to `pending` (rule U10). */
  'deposit.txid_bounced': z.strictObject({
    depositId: z.uuid(),
    txid: z.string(),
    error: usdtCheckErrorSchema,
  }),
  /** The admin re-sent the verification (rule U17). */
  'deposit.rechecked': deposit,
  /** S05 rule SW2: the entity is the change row; the channel says panel or Telegram. */
  'store_switch.changed': z.strictObject({
    switch: storeSwitchSchema,
    before: z.boolean(),
    after: z.boolean(),
  }),
} as const satisfies Record<string, z.ZodType>;

export type AuditAction = keyof typeof AUDIT_DETAILS;

export const AUDIT_ACTIONS = Object.keys(AUDIT_DETAILS) as AuditAction[];

export const auditActionSchema = z
  .enum(AUDIT_ACTIONS as [AuditAction, ...AuditAction[]])
  .meta({ id: 'AuditAction' });

export type AuditDetails<Action extends AuditAction> = z.infer<(typeof AUDIT_DETAILS)[Action]>;

/** One entry as the audit log screen shows it (`GET /api/admin/audit`). */
export const auditEntrySchema = z
  .object({
    id: z.uuid(),
    occurredAt: z.iso.datetime(),
    actorKind: auditActorKindSchema,
    actorId: z.uuid().nullable(),
    /** The admin's or the customer's name; null for system and CLI entries. */
    actorName: z.string().nullable(),
    channel: auditChannelSchema,
    action: auditActionSchema,
    entityType: auditEntityTypeSchema,
    entityId: z.uuid(),
    reason: z.string().nullable(),
    details: z.record(z.string(), z.unknown()),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry' });

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** The audit log filters (rule A4): newest first, a cursor to load more. */
export const auditListQuerySchema = cursorQuerySchema
  .extend({
    actorKind: auditActorKindSchema.optional(),
    /** With `actorKind` customer or admin: one actor's entries. */
    actorId: z.uuid().optional(),
    action: auditActionSchema.optional(),
    entityType: auditEntityTypeSchema.optional(),
    entityId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({ id: 'AuditListQuery' });

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const auditPageSchema = cursorPageSchema(auditEntrySchema, 'AuditPage');

export type AuditPage = z.infer<typeof auditPageSchema>;
