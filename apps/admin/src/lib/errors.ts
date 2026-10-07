import type { TFunction } from 'i18next';
import ar from '../i18n/locales/ar.json';
import { ApiError } from './api/client';

/** Better Auth error codes the sign-in and 2FA screens explain. */
const AUTH_CODES = [
  'INVALID_EMAIL_OR_PASSWORD',
  'INVALID_PASSWORD',
  'INVALID_CODE',
  'INVALID_BACKUP_CODE',
  'INVALID_TWO_FACTOR_COOKIE',
] as const;

type AuthCode = (typeof AUTH_CODES)[number];

/** API error codes the panel explains (`errors.api.<code>`); others get the generic message. */
type ApiCode = keyof typeof ar.errors.api;

const isApiCode = (code: string | undefined): code is ApiCode => !!code && code in ar.errors.api;

/** A Better Auth client error: `{ code, message, status }`. */
export interface AuthClientError {
  code?: string;
  status: number;
}

/** The message to show for a failed API or Better Auth call; never the server's own text. */
export function errorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    if (isApiCode(error.knownCode)) return t(`errors.api.${error.knownCode}`);
    if (error.status === 429) return t('errors.TOO_MANY_REQUESTS');
    return t('errors.generic');
  }
  const auth = error as Partial<AuthClientError> | null;
  if (auth?.status === 429) return t('errors.TOO_MANY_REQUESTS');
  // Better Auth reports a failed fetch with status 0.
  if (auth?.status === 0) return t('errors.network');
  if (auth?.code && (AUTH_CODES as readonly string[]).includes(auth.code)) {
    return t(`errors.auth.${auth.code as AuthCode}`);
  }
  if (isApiCode(auth?.code)) return t(`errors.api.${auth.code}`);
  return t('errors.generic');
}

/** The code of a failed API or Better Auth call. */
export function errorCode(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.code;
  return (error as Partial<AuthClientError> | null)?.code;
}

/**
 * A refused request, and where to show it: `field` when the password just typed was wrong
 * (under that field), otherwise for the whole form.
 */
export interface Failure {
  message: string;
  field: boolean;
}

/** For the forms that confirm an action with the current password. */
export function passwordFailure(t: TFunction, error: unknown): Failure {
  return { message: errorMessage(t, error), field: errorCode(error) === 'INVALID_PASSWORD' };
}
