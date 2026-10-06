import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorCodeSchema, errorResponseSchema } from './errors.js';

describe('error codes', () => {
  it('are unique UPPER_SNAKE_CASE codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
  });

  it('accept only known codes', () => {
    expect(errorCodeSchema.safeParse('INSUFFICIENT_BALANCE').success).toBe(true);
    expect(errorCodeSchema.safeParse('SOMETHING_ELSE').success).toBe(false);
  });
});

describe('error response', () => {
  it('is a status, a known code and a message, with optional details', () => {
    expect(
      errorResponseSchema.parse({ statusCode: 403, code: 'FORBIDDEN', message: 'Forbidden' }),
    ).toEqual({ statusCode: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    expect(
      errorResponseSchema.safeParse({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: 'Invalid input',
        details: [{ path: ['email'] }],
      }).success,
    ).toBe(true);
  });

  it('refuses a success status or an unknown code', () => {
    expect(
      errorResponseSchema.safeParse({ statusCode: 200, code: 'FORBIDDEN', message: '' }).success,
    ).toBe(false);
    expect(
      errorResponseSchema.safeParse({ statusCode: 400, code: 'NOPE', message: '' }).success,
    ).toBe(false);
  });
});
