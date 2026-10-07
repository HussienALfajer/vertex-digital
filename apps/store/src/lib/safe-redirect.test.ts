import { describe, expect, it } from 'vitest';
import { safeRedirect } from './safe-redirect';

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
  ])('sends %j home', (target) => {
    expect(safeRedirect(target, origin)).toBe('/');
  });
});
