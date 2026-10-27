import { describe, expect, it } from 'vitest';
import { formatDamascusDay, fromDamascusInput, toDamascusInput } from './damascus-time';

describe('Damascus schedule fields (S14 BN4)', () => {
  it('shows an instant as Damascus wall-clock time (UTC+3)', () => {
    expect(toDamascusInput('2026-10-10T22:30:00.000Z')).toBe('2026-10-11T01:30');
  });

  it('reads a field as Damascus time', () => {
    expect(fromDamascusInput('2026-10-11T01:30')).toBe('2026-10-10T22:30:00.000Z');
    expect(fromDamascusInput('2027-01-01T00:00')).toBe('2026-12-31T21:00:00.000Z');
  });

  it('round-trips', () => {
    const iso = '2026-12-31T21:05:00.000Z';
    expect(fromDamascusInput(toDamascusInput(iso))).toBe(iso);
  });

  it('refuses a malformed value', () => {
    expect(fromDamascusInput('')).toBeNull();
    expect(fromDamascusInput('2026-10-11 01:30')).toBeNull();
  });
});

describe('formatDamascusDay (S14 PG2, audit A08-27)', () => {
  it('names the Damascus day, as the store does, whatever the viewer zone', () => {
    // 22:30 UTC on the 10th is already the 11th in Damascus.
    expect(formatDamascusDay('2026-10-10T22:30:00.000Z')).toMatch(/^11 /);
    expect(formatDamascusDay('2026-10-10T22:30:00.000Z')).toContain('2026');
  });
});
