import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { z } from 'zod';
import { COMMON_PASSWORDS } from './common-passwords.data.js';

/*
 * Account forms (ADR 0007, S01), owned by the api `auth` (customers) and `admin` modules. Better
 * Auth checks the credentials; these schemas shape and validate what the forms send.
 */

/** Email and password. Password rules apply where passwords are set, not at sign-in. */
export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

/** `POST /api/auth/email-otp/verify-email` (rule C7): the code signs the customer in. */
export const verifyEmailSchema = z.object({ email: z.email(), otp: z.string().min(1).max(10) });

export type SignIn = z.infer<typeof signInSchema>;

/** The 6-digit code of an authenticator app (admin TOTP). */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);

/** The 6-digit code of an email (rule C4). */
export const otpCodeSchema = z.string().regex(/^\d{6}$/);

/**
 * An admin backup code as written down: `xxxxx-xxxxx` from the API's alphabet (no look-alikes).
 * Spaces around it and capital letters are forgiven, since codes are typed by hand.
 */
export const backupCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);

const commonPasswords = new Set(COMMON_PASSWORDS.split('\n').filter(Boolean));

/** Whether a password is in the common-password list, whatever its case (rules C3, D6). */
export function isCommonPassword(password: string): boolean {
  return commonPasswords.has(password.toLowerCase());
}

/** The message of the issue a common password raises; the API answers `PASSWORD_TOO_COMMON`. */
export const PASSWORD_TOO_COMMON = 'PASSWORD_TOO_COMMON';

/** The message of the issue a new password equal to the current one raises. */
export const PASSWORD_UNCHANGED = 'PASSWORD_UNCHANGED';

/** The message of the issue a password equal to the account's email raises. */
export const PASSWORD_EQUALS_EMAIL = 'PASSWORD_EQUALS_EMAIL';

const password = (min: number) =>
  z
    .string()
    .min(min)
    .max(128)
    .refine((value) => !isCommonPassword(value), { message: PASSWORD_TOO_COMMON });

/** Customer passwords (rule C3): 8 to 128 characters, no composition rules, not common. */
export const passwordSchema = password(8);

/** Admin passwords (rule D6): 12 to 128 characters, not common. */
export const adminPasswordSchema = password(12);

/** Whether a password equals the account's email, ignoring case (rules C3, D6). */
export function passwordEqualsEmail(password: string, email: string): boolean {
  return password.trim().toLowerCase() === email.trim().toLowerCase();
}

/** A person's full name: 2 to 60 characters after trimming, no control characters. */
export const fullNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[^\p{Cc}]+$/u);

/**
 * A phone number in any form a person types (`09…` in Syria, `+963…`, `00963…`, with spaces or
 * dashes), normalized to E.164. Syria is the default region; any valid number is accepted. Not
 * unique and not verified (ADR 0007, rule C6).
 */
export const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform((value, context) => {
    const typed = value.replace(/[\s\-().]/g, '').replace(/^00/, '+');
    const parsed = parsePhoneNumberFromString(typed, 'SY');
    if (!parsed?.isValid()) {
      context.addIssue({ code: 'custom', message: 'Invalid phone number' });
      return z.NEVER;
    }
    return parsed.number;
  });

/** Refuses a password equal to the email of the same form (rules C3, D6). */
const passwordNotEmail = (value: { email: string; password: string }, context: z.RefinementCtx) => {
  if (passwordEqualsEmail(value.password, value.email)) {
    context.addIssue({ code: 'custom', path: ['password'], message: PASSWORD_EQUALS_EMAIL });
  }
};

/** `POST /api/auth/sign-up/email` (rule C1). */
export const customerSignUpSchema = z
  .object({
    name: fullNameSchema,
    email: z.email().max(254),
    password: passwordSchema,
    phone: phoneSchema,
  })
  .superRefine(passwordNotEmail)
  .meta({ id: 'CustomerSignUp' });

export type CustomerSignUp = z.input<typeof customerSignUpSchema>;

/** `POST /api/auth/email-otp/reset-password`: the code and the new password (rule C7). */
export const resetPasswordSchema = z
  .object({ email: z.email(), otp: otpCodeSchema, password: passwordSchema })
  .superRefine(passwordNotEmail)
  .meta({ id: 'ResetPassword' });

/** `GET /api/account`: the customer's own profile. */
export const customerProfileSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    phone: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'CustomerProfile' });

export type CustomerProfile = z.infer<typeof customerProfileSchema>;

/** `PATCH /api/account`: name and phone (rule C13); at least one of them. */
export const updateCustomerProfileSchema = z
  .object({ name: fullNameSchema, phone: phoneSchema })
  .partial()
  .refine((value) => value.name !== undefined || value.phone !== undefined, {
    message: 'Nothing to update',
  })
  .meta({ id: 'UpdateCustomerProfile' });

export type UpdateCustomerProfile = z.input<typeof updateCustomerProfileSchema>;

/** `POST /api/auth/email-otp/request-email-change` (rule C12). */
export const requestEmailChangeSchema = z
  .object({ newEmail: z.email().max(254), password: z.string().min(1) })
  .meta({ id: 'RequestEmailChange' });

export type RequestEmailChange = z.infer<typeof requestEmailChangeSchema>;

/** `POST /api/admin/me/reauthenticate` (rule D5): backup codes are not accepted. */
export const reauthenticateSchema = z
  .object({ password: z.string().min(1), totpCode: totpCodeSchema })
  .meta({ id: 'Reauthenticate' });

export type Reauthenticate = z.infer<typeof reauthenticateSchema>;

/** The answer of a re-authentication: sensitive routes are open until then (rule D5). */
export const reauthenticationSchema = z
  .object({ reauthenticatedUntil: z.iso.datetime() })
  .meta({ id: 'Reauthentication' });

export type Reauthentication = z.infer<typeof reauthenticationSchema>;

/** `POST /api/auth/change-password` (rule C11): every other session is signed out. */
export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
  .meta({ id: 'ChangePassword' });

export type ChangePassword = z.infer<typeof changePasswordSchema>;

/** `POST /api/admin/auth/change-password` (rules D1, D7): the admin's password rules. */
export const adminChangePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: adminPasswordSchema })
  // A CLI-issued password must really change: "changing" it to itself would keep it (rule D1).
  .refine((value) => value.newPassword !== value.currentPassword, {
    path: ['newPassword'],
    message: PASSWORD_UNCHANGED,
  })
  .meta({ id: 'AdminChangePassword' });

export type AdminChangePassword = z.infer<typeof adminChangePasswordSchema>;

/** `POST /api/auth/email-otp/send-verification-otp` and `request-password-reset` (rule C5). */
export const requestCodeSchema = z
  .object({ email: z.email().max(254) })
  .meta({ id: 'RequestCode' });

/** `POST /api/auth/email-otp/change-email` (rule C12). */
export const confirmEmailChangeSchema = z
  .object({ newEmail: z.email().max(254), otp: otpCodeSchema })
  .meta({ id: 'ConfirmEmailChange' });

/** `POST /api/auth/revoke-session`: one of the customer's own sessions (rule C14). */
export const revokeSessionSchema = z
  .object({ token: z.string().min(1).max(200) })
  .meta({ id: 'RevokeSession' });

/** The answer of an action that has nothing else to say. */
export const successSchema = z.object({ success: z.literal(true) }).meta({ id: 'Success' });

/** `GET /api/auth/registration`: whether customers can sign up (rule C16). */
export const registrationSchema = z.object({ open: z.boolean() }).meta({ id: 'Registration' });

export type Registration = z.infer<typeof registrationSchema>;

/** The answer of a sign-up, the same whether or not the email has an account (rule C2). */
export const signUpResultSchema = z
  .object({ status: z.literal('code_sent') })
  .meta({ id: 'SignUpResult' });
