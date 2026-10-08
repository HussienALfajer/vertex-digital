import { z } from 'zod';
import { otpCodeSchema } from './auth.js';
import { depositRejectReasonSchema } from './deposits.js';
import { adjustmentCategorySchema, adjustmentDirectionSchema } from './wallet.js';

/*
 * Emails, owned by the api `notifications` module (S01 rules E1–E5): every email is a row of the
 * outbox and an `email.send` job, sent by the worker. Emails never carry a password, a link with
 * a token or a free-text value someone else typed (a sign-up name could be spam for a stranger).
 */

export const EMAIL_TEMPLATES = [
  /** The code that verifies a new account's email (rule C1). */
  'customer_verify_email',
  /** The code that resets a forgotten password (rule C7). */
  'customer_reset_password',
  /** The code that confirms a new email address, sent to it (rule C12). */
  'customer_change_email',
  /** To the old address once the email changed (rule C12). */
  'customer_email_changed',
  /** After a password change or reset (rules C7, C11). */
  'customer_password_changed',
  /** After a sign-in, with the device and address (rule C10). */
  'customer_new_sign_in',
  /** Someone tried to sign up, or to move an account, with this address (rules C2, C12). */
  'customer_sign_up_attempt',
  /** The admin adjusted the wallet, or reversed an adjustment (S02); never the reason or note. */
  'customer_wallet_adjusted',
  /** A deposit was approved and credited (S03); the amount, never the transaction number. */
  'customer_deposit_credited',
  /** A deposit was rejected (rule RV6): the reason's words, never the admin's note. */
  'customer_deposit_rejected',
  /** The admin asked for a clearer receipt (rule RV8), never the note. */
  'customer_deposit_receipt_requested',
] as const;

export const emailTemplateSchema = z.enum(EMAIL_TEMPLATES);

export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const EMAIL_PRIORITIES = ['high', 'normal'] as const;

export type EmailPriority = (typeof EMAIL_PRIORITIES)[number];

export const EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const code = z.object({ code: otpCodeSchema });
const at = z.object({ at: z.iso.datetime() });

/** The parameters each template is rendered with. */
export const EMAIL_PARAMS = {
  customer_verify_email: code,
  customer_reset_password: code,
  customer_change_email: code,
  customer_email_changed: at,
  customer_password_changed: at,
  customer_new_sign_in: at.extend({
    browser: z.string(),
    system: z.string(),
    ipAddress: z.string().nullable(),
  }),
  customer_sign_up_attempt: z.object({}),
  customer_wallet_adjusted: at.extend({
    direction: adjustmentDirectionSchema,
    amountUnits: z.int().positive(),
    category: adjustmentCategorySchema,
    reversal: z.boolean(),
  }),
  customer_deposit_credited: at.extend({
    depositId: z.uuid(),
    referenceCode: z.string(),
    creditedUsdUnits: z.int().positive(),
  }),
  customer_deposit_rejected: z.object({
    depositId: z.uuid(),
    referenceCode: z.string(),
    reason: depositRejectReasonSchema,
  }),
  customer_deposit_receipt_requested: z.object({
    depositId: z.uuid(),
    referenceCode: z.string(),
  }),
} as const satisfies Record<EmailTemplate, z.ZodType>;

export type EmailParams<Template extends EmailTemplate> = z.infer<(typeof EMAIL_PARAMS)[Template]>;

/** Templates that carry a code: high priority, never sent after the code expired (rule E2). */
export const CODE_EMAIL_TEMPLATES = [
  'customer_verify_email',
  'customer_reset_password',
  'customer_change_email',
] as const satisfies readonly EmailTemplate[];

export function isCodeEmail(template: EmailTemplate): boolean {
  return (CODE_EMAIL_TEMPLATES as readonly EmailTemplate[]).includes(template);
}

/** How long an email code is valid (rule C4). */
export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
