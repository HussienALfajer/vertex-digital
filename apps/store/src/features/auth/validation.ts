import {
  fullNameSchema,
  isCommonPassword,
  otpCodeSchema,
  passwordEqualsEmail,
  signInSchema,
} from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';

/*
 * Field messages for the account forms. The contract schemas decide what is valid; these pick the
 * message that tells the customer what to change. Each returns undefined for a valid value.
 */

export function emailError(email: string): string | undefined {
  if (!email) return t('validation.emailRequired');
  return signInSchema.shape.email.safeParse(email).success
    ? undefined
    : t('validation.emailInvalid');
}

/** A password the customer types to prove who they are: only required. */
export function currentPasswordError(password: string): string | undefined {
  return password ? undefined : t('validation.passwordRequired');
}

/** A new password (rule C3): 8 to 128 characters, not common, not the email. */
export function newPasswordError(password: string, email?: string): string | undefined {
  if (!password) return t('validation.passwordRequired');
  if (password.length < 8) return t('validation.passwordShort');
  if (password.length > 128) return t('validation.passwordLong');
  if (isCommonPassword(password)) return t('validation.passwordCommon');
  if (email && passwordEqualsEmail(password, email)) return t('validation.passwordEqualsEmail');
  return undefined;
}

export function nameError(name: string): string | undefined {
  return fullNameSchema.safeParse(name).success ? undefined : t('validation.nameRequired');
}

export function codeError(code: string): string | undefined {
  return otpCodeSchema.safeParse(code).success ? undefined : t('validation.codeInvalid');
}

/** Moves the focus to the first refused field of a form, in the order of `names`. */
export function focusFirst(form: HTMLFormElement, errors: Record<string, string | undefined>) {
  const first = Object.keys(errors).find((name) => errors[name]);
  if (first) form.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
}
