import { describe, expect, it } from 'vitest';
import { countryOf, countryOptions, formatPhone, nationalPhone, toE164 } from './phone';

describe('toE164', () => {
  it.each([
    ['0944123456', 'SY', '+963944123456'],
    ['0944 123 456', 'SY', '+963944123456'],
    ['+963 944-123-456', 'SY', '+963944123456'],
    ['00963944123456', 'SY', '+963944123456'],
    // A number with its country code keeps it, whatever the picker says.
    ['+90 532 123 45 67', 'SY', '+905321234567'],
    ['0532 123 45 67', 'TR', '+905321234567'],
  ] as const)('reads %s in %s as %s', (typed, country, e164) => {
    expect(toE164(typed, country)).toBe(e164);
  });

  it.each(['', '12', '0944', 'not a number', '+963 1'])('refuses %j', (typed) => {
    expect(toE164(typed, 'SY')).toBeNull();
  });
});

describe('display', () => {
  it('formats an E.164 number for reading and for editing', () => {
    expect(formatPhone('+963944123456')).toBe('+963 944 123 456');
    expect(nationalPhone('+963944123456')).toBe('0944 123 456');
    expect(countryOf('+905321234567')).toBe('TR');
  });
});

describe('countryOptions', () => {
  it('starts with Syria and names countries in Arabic', () => {
    const options = countryOptions();
    expect(options[0]).toEqual({ code: 'SY', name: 'سوريا', dialCode: '+963' });
    expect(options.length).toBeGreaterThan(200);
  });
});
