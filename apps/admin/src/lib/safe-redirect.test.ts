import { describe, expect, it } from 'vitest';
import { safeRedirect } from './safe-redirect';

const origin = 'https://digital-admin.vertexmedia.pro';

describe('safeRedirect', () => {
  it('keeps a path of the panel', () => {
    expect(safeRedirect('/orders?page=2#top', origin)).toBe('/orders?page=2#top');
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
