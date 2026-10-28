import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from './chunk-error';

describe('isChunkLoadError (audit A10-7)', () => {
  it('knows the chunk failures of Next, Chromium and Safari', () => {
    const named = Object.assign(new Error('Loading chunk 812 failed.'), { name: 'ChunkLoadError' });
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk app-layout failed'))).toBe(true);
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /x.js')),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  it('leaves every other error to the retry', () => {
    expect(isChunkLoadError(new Error('GET /api/catalog/storefront answered 503'))).toBe(false);
    expect(isChunkLoadError('Loading chunk 1 failed')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
