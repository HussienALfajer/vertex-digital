import { describe, expect, it } from 'vitest';
import { SignInFailures } from '../src/core/rate-limit/sign-in-failures.js';

/* The per-email sign-in failures behind the ALTCHA step (ADR 0007, S01 C8; audit A01-4). */

const MINUTE = 60 * 1000;

describe('sign-in failures', () => {
  it('blocks an email after the limit within the window, and forgets it after', () => {
    const failures = new SignInFailures(3, 15 * MINUTE);
    for (const at of [0, MINUTE, 2 * MINUTE]) failures.fail('a@example.test', at);
    expect(failures.blocked('a@example.test', 3 * MINUTE)).toBe(true);
    expect(failures.blocked('a@example.test', 16 * MINUTE)).toBe(false);
    expect(failures.blocked('a@example.test', 18 * MINUTE)).toBe(false);
    failures.fail('b@example.test', 0);
    failures.clear('b@example.test');
    expect(failures.size).toBe(0);
  });

  it('never holds more emails than its cap, dropping the stale ones first (A01-4)', () => {
    const failures = new SignInFailures(3, 15 * MINUTE, 100);
    // Three failures for a real target, then a spray over made-up emails.
    for (const at of [0, MINUTE, 2 * MINUTE]) failures.fail('target@example.test', at);
    for (let n = 0; n < 1_000; n += 1) failures.fail(`made-up-${n}@example.test`, 3 * MINUTE + n);
    expect(failures.size).toBeLessThanOrEqual(100);
    // The spray never washes out the email that asks for the ALTCHA.
    expect(failures.blocked('target@example.test', 4 * MINUTE)).toBe(true);
    // Past the window, sprayed emails are dropped before any fresh failure.
    for (let n = 0; n < 50; n += 1) failures.fail(`late-${n}@example.test`, 30 * MINUTE);
    expect(failures.size).toBe(50);
  });
});
