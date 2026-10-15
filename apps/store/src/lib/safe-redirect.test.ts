import { describe, expect, it } from 'vitest';
import { safeRedirect, withNext } from './safe-redirect';

const origin = 'https://digital.vertexmedia.pro';

describe('safeRedirect', () => {
  it('keeps a path of the store', () => {
    expect(safeRedirect('/account?tab=1#top', origin)).toBe('/account?tab=1#top');
  });

  it.each([
    undefined,
    42,
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example/',
    '/\n/evil.example',
    'orders',
    // Not a URL the browser can open: it threw after the sign-in had worked (2026-10-15 audit).
    '//[',
  ])('sends %j home', (target) => {
    expect(safeRedirect(target, origin)).toBe('/');
  });
});

describe('withNext', () => {
  it('keeps where the customer was heading, encoded, between the account screens', () => {
    expect(withNext('/sign-up', '/cart?line=2', origin)).toBe('/sign-up?next=%2Fcart%3Fline%3D2');
  });

  it.each([null, undefined, '', '/', '//evil.example/', '//['])('drops %j', (next) => {
    expect(withNext('/sign-in', next, origin)).toBe('/sign-in');
  });
});
