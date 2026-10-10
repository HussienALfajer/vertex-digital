import { z } from 'zod';
import {
  catalogStatusSchema,
  inputFieldTypeSchema,
  productKindSchema,
  selectOptionSchema,
} from './catalog.js';
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
import { notificationEventSchema } from './notifications.js';
import {
  cancelReasonSchema,
  orderPolicySchema,
  refundReasonSchema,
  shareKindSchema,
} from './orders.js';
import { marginRuleValuesSchema, marginScopeSchema } from './pricing.js';
import { displayStepSchema } from './rates.js';
import { storeSwitchSchema } from './settings.js';
import { supplierCodeSchema, supplierPolicySchema } from './suppliers.js';
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
  'telegram_link',
  'catalog_category',
  'catalog_game',
  'catalog_input_field',
  'catalog_product',
  'margin_rule',
  'supplier',
  'supplier_policy',
  'supplier_offer',
  'product_route',
  'price_review',
  'order',
  'order_policy',
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
    telegramApprovalMaxUsdUnits: z.int(),
  })
  .partial();
const depositQuote = z.strictObject({
  rateId: z.uuid(),
  rate: exchangeRateSchema,
  declaredUsdUnits: z.int().positive(),
});
const flagCodes = z.array(depositFlagCodeSchema);
const deposit = z.strictObject({ depositId: z.uuid() });

/** Catalog values in audit details (S06): image changes as file ids. */
const categoryValues = { slug: z.string(), nameAr: z.string() };
const gameValues = {
  categoryId: z.uuid(),
  slug: z.string(),
  nameAr: z.string(),
  nameEn: z.string(),
  status: catalogStatusSchema,
  coverFileId: z.uuid().nullable(),
  idGuideFileId: z.uuid().nullable(),
  accentColor: z.string().nullable(),
  regionNotesAr: z.string().nullable(),
};
/** A field's `key` is recorded as `identifier`: the audit test refuses any key named like a secret. */
const inputFieldValues = {
  identifier: z.string(),
  labelAr: z.string(),
  helpAr: z.string().nullable(),
  type: inputFieldTypeSchema,
  required: z.boolean(),
  minLength: z.int().nullable(),
  maxLength: z.int().nullable(),
  options: z.array(selectOptionSchema).nullable(),
};
const productValues = {
  kind: productKindSchema,
  nameAr: z.string(),
  gameAmount: z.int().nullable(),
  officialPriceUsdUnits: z.int().nullable(),
  maxQuantity: z.int(),
  regionAr: z.string().nullable(),
  redemptionAr: z.string().nullable(),
  status: catalogStatusSchema,
};
const reordered = <Shape extends z.ZodRawShape>(parent: Shape) =>
  z.strictObject({ ...parent, ids: z.array(z.uuid()) });
const named = <Shape extends z.ZodRawShape>(parent: Shape) =>
  z.strictObject({ ...parent, nameAr: z.string() });
const marginTarget = { scope: marginScopeSchema, targetId: z.uuid().nullable() };
const marginValues = marginRuleValuesSchema.strict();
/** Supplier values in audit details (S07): never a credential, only field names and hints. */
const supplier = { supplier: supplierCodeSchema };
const routeValues = {
  priority: z.int(),
  enabled: z.boolean(),
  fieldMap: z.record(z.string(), z.string()),
};
const reviewDecision = z.strictObject({
  productId: z.uuid(),
  priceBeforeUsdUnits: z.int(),
  priceAfterUsdUnits: z.int(),
});

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
  /** S05 rule NT8: one email choice changed on `/account`. */
  'customer.notification_preference_changed': z.strictObject({
    event: notificationEventSchema,
    email: z.boolean(),
  }),
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
  /** S05 rule TG3: the entity is the code row; never the code itself. */
  'telegram.link_code_created': z.strictObject({ expiresAt: z.iso.datetime() }),
  /** By `/start <code>` (channel `telegram`): the entity is the new link. */
  'telegram.linked': z.strictObject({
    telegramUserId: z.int(),
    previousLinkId: z.uuid().nullable(),
  }),
  /** From the panel: the entity is the link that ended. */
  'telegram.unlinked': z.strictObject({ linkId: z.uuid() }),
  /** S06 rule CT1–CT5: each catalog change in the transaction of its change. */
  'catalog_category.created': z.strictObject(categoryValues),
  'catalog_category.updated': changed(categoryValues),
  'catalog_category.archived': named({}),
  'catalog_category.restored': named({}),
  'catalog_category.reordered': reordered({}),
  'catalog_game.created': z.strictObject(gameValues),
  /** Status changes included (rule CT4). */
  /** S09 rule AD1: the search terms change with the game. */
  'catalog_game.updated': changed({ ...gameValues, searchTerms: z.array(z.string()) }),
  'catalog_game.archived': named({}),
  'catalog_game.restored': named({}),
  'catalog_game.reordered': reordered({ categoryId: z.uuid() }),
  'catalog_input_field.created': z.strictObject({ gameId: z.uuid(), ...inputFieldValues }),
  'catalog_input_field.updated': changed(inputFieldValues),
  'catalog_input_field.archived': z.strictObject({ gameId: z.uuid(), identifier: z.string() }),
  'catalog_input_field.restored': z.strictObject({ gameId: z.uuid(), identifier: z.string() }),
  'catalog_input_field.reordered': reordered({ gameId: z.uuid() }),
  'catalog_product.created': z.strictObject({ gameId: z.uuid(), ...productValues }),
  'catalog_product.updated': changed(productValues),
  'catalog_product.archived': named({ gameId: z.uuid() }),
  'catalog_product.restored': named({ gameId: z.uuid() }),
  'catalog_product.reordered': reordered({ gameId: z.uuid() }),
  /** S06 rule PR9: `before` is null for a new rule. */
  'margin_rule.set': z.strictObject({
    ...marginTarget,
    before: marginValues.nullable(),
    after: marginValues,
  }),
  'margin_rule.archived': z.strictObject({ ...marginTarget, values: marginValues }),
  /** S07 rule SP2: the field names and their last 4 characters, never the values. */
  'supplier.credentials_set': z.strictObject({
    ...supplier,
    fields: z.array(z.string()),
    hints: z.record(z.string(), z.string()),
  }),
  'supplier.updated': z.strictObject({
    ...supplier,
    ...changed({ lowBalanceUsdUnits: z.int() }).shape,
  }),
  'supplier.sync_requested': z.strictObject({ ...supplier, runId: z.uuid() }),
  /** S09 rule AD2. */
  'supplier.validation_quota_set': z.strictObject({
    ...supplier,
    before: z.int().nonnegative(),
    after: z.int().nonnegative(),
  }),
  /** Rule RT8: with a `catalog_product.created` and a `product_route.created` per row. */
  'supplier.import': z.strictObject({ ...supplier, gameId: z.uuid(), count: z.int().positive() }),
  /** `before` is the policy in force, the seed included. */
  'supplier_policy.set': z.strictObject({
    before: supplierPolicySchema.strict(),
    after: supplierPolicySchema.strict(),
  }),
  /** Rule RT7: `before` is null for a new manual offer. */
  'supplier_offer.manual_cost_set': z.strictObject({
    productId: z.uuid(),
    beforeUsdUnits: z.int().nullable(),
    afterUsdUnits: z.int(),
  }),
  'product_route.created': z.strictObject({
    ...supplier,
    productId: z.uuid(),
    offerId: z.uuid(),
    ...routeValues,
  }),
  'product_route.updated': z.strictObject({
    productId: z.uuid(),
    ...changed(routeValues).shape,
  }),
  'product_route.archived': z.strictObject({ ...supplier, productId: z.uuid() }),
  'product_route.restored': z.strictObject({ ...supplier, productId: z.uuid() }),
  /** Rule P4, with `catalog_product.updated` for a pause and `margin_rule.set` for a margin. */
  'price_review.accepted': reviewDecision,
  'price_review.paused': reviewDecision,
  'price_review.margin_adjusted': reviewDecision,
  /** S08 rule AU1: the customer's purchase (rule O2). */
  'order.paid': z.strictObject({
    number: z.string(),
    productId: z.uuid(),
    quantity: z.int().positive(),
    totalUsdUnits: z.int().positive(),
    journalId: z.uuid(),
    /** S09 rule RS6, for a reservation paid by the system: which unit price it took. */
    priceSource: z.enum(['saved', 'current']).optional(),
    /** S10: the checkout that paid it (rule CT5), and a gift (rule GF1). */
    checkoutId: z.uuid().optional(),
    gift: z.boolean().optional(),
  }),
  /** S09 rule RS1: the customer reserved an order; no money moved. */
  'order.reserved': z.strictObject({
    number: z.string(),
    productId: z.uuid(),
    quantity: z.int().positive(),
    totalUsdUnits: z.int().positive(),
    expiresAt: z.iso.datetime(),
  }),
  /** S09 rules RS7–RS9: a reservation cancelled by the customer or the system. */
  'order.cancelled': z.strictObject({ reason: cancelReasonSchema }),
  /** Rule M2, by the system: the cost of one delivered attempt. */
  'order.cost_posted': z.strictObject({
    ...supplier,
    attemptId: z.uuid(),
    units: z.int().positive(),
    costUsdUnits: z.int().positive(),
    journalId: z.uuid(),
  }),
  /** Rule M3, by the system or the admin. */
  'order.refunded': z.strictObject({
    units: z.int().positive(),
    amountUsdUnits: z.int().positive(),
    reason: refundReasonSchema,
    journalId: z.uuid(),
  }),
  /** Rules D1–D5: the admin's decisions, with the reason in the entry's `reason`. */
  'order.poll_requested': z.strictObject({ attemptId: z.uuid() }),
  /** Rules D2, D3: the units delivered and how many codes were typed, never the codes. */
  'order.attempt_resolved': z.strictObject({
    attemptId: z.uuid(),
    outcome: z.enum(['delivered', 'failed']),
    units: z.int().nonnegative(),
    items: z.int().nonnegative(),
  }),
  'order.refund_decided': z.strictObject({
    attemptId: z.uuid().nullable(),
    units: z.int().positive(),
    amountUsdUnits: z.int().positive(),
  }),
  /** S10 rule AD1: the admin revoked a share link, with the reason in the entry's `reason`. */
  'order.share_revoked': z.strictObject({ linkId: z.uuid(), kind: shareKindSchema }),
  /** S11 rule AU1: a reroute, with the reason in the entry's `reason`. */
  'order.rerouted': z.strictObject({
    closedAttemptId: z.uuid().nullable(),
    attemptId: z.uuid(),
    routeId: z.uuid(),
    ...supplier,
  }),
  /** S11 rule AU1: a manual fulfil; the number of codes typed, never the codes. */
  'order.fulfilled_manually': z.strictObject({
    attemptId: z.uuid(),
    case: z.enum(['manual_attempt', 'review']),
    units: z.int().positive(),
    unitCostUsdUnits: z.int().nonnegative(),
    lossAccepted: z.boolean(),
    proofFileId: z.uuid(),
    hasReference: z.boolean(),
    items: z.int().nonnegative(),
  }),
  'order.proof_uploaded': z.strictObject({ fileId: z.uuid() }),
  /** Rule C3: which stored item was shown, never its value. */
  'order.code_revealed': z.strictObject({ itemId: z.uuid(), position: z.int().positive() }),
  /** `before` is the policy in force, the seed included. */
  'order_policy.set': z.strictObject({
    before: orderPolicySchema.strict(),
    after: orderPolicySchema.strict(),
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
