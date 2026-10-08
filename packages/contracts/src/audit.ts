import { z } from 'zod';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { exchangeRateSchema } from './money.js';
import { displayStepSchema } from './rates.js';
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
