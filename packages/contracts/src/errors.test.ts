import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorCodeSchema } from './errors.js';

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
