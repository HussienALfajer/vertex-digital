import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import ar from '../i18n/locales/ar.json';
import { ApiError } from './api/client';
import { errorMessage, passwordFailure } from './errors';

const t = i18n.t;

describe('errorMessage', () => {
  it('translates the Better Auth codes the screens explain', () => {
    expect(errorMessage(t, { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe(
      ar.errors.auth.INVALID_EMAIL_OR_PASSWORD,
    );
    expect(errorMessage(t, { status: 401, code: 'INVALID_CODE' })).toBe(
      ar.errors.auth.INVALID_CODE,
    );
  });

  it('translates the API codes the panel explains, from the API and from Better Auth', () => {
    expect(errorMessage(t, new ApiError(409, 'EMAIL_TAKEN', undefined, 'x'))).toBe(
      ar.errors.api.EMAIL_TAKEN,
    );
    expect(errorMessage(t, { status: 401, code: 'SESSION_IDLE_EXPIRED' })).toBe(
      ar.errors.api.SESSION_IDLE_EXPIRED,
    );
  });

  it('tells rate limits and network failures apart', () => {
    expect(errorMessage(t, { status: 429 })).toBe(ar.errors.TOO_MANY_REQUESTS);
    expect(errorMessage(t, new ApiError(429, 'RATE_LIMITED', undefined, 'x'))).toBe(
      ar.errors.TOO_MANY_REQUESTS,
    );
    expect(errorMessage(t, { status: 0 })).toBe(ar.errors.network);
  });

  it('never shows an unknown code or the server text', () => {
    expect(errorMessage(t, { status: 400, code: 'SOMETHING_ELSE' })).toBe(ar.errors.generic);
    expect(errorMessage(t, new ApiError(500, 'INTERNAL_ERROR', undefined, 'boom'))).toBe(
      ar.errors.generic,
    );
    expect(errorMessage(t, null)).toBe(ar.errors.generic);
  });
});

describe('passwordFailure', () => {
  it('puts a wrong password under its field, anything else on the form', () => {
    expect(passwordFailure(t, { status: 400, code: 'INVALID_PASSWORD' }).field).toBe(true);
    expect(passwordFailure(t, { status: 429 }).field).toBe(false);
    expect(passwordFailure(t, new ApiError(400, 'INVALID_PASSWORD', undefined, 'x')).field).toBe(
      true,
    );
  });
});
