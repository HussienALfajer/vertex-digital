import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { logoShape, markShape } from './logo-shapes';

function fileShape(name: string) {
  const source = readFileSync(
    new URL(`../../../../brand/logo/svg/${name}`, import.meta.url),
    'utf8',
  );
  return {
    viewBox: /viewBox="([^"]+)"/.exec(source)?.[1],
    d: /<path[^>]*\sd="([^"]+)"/.exec(source)?.[1],
  };
}

describe('logo shapes', () => {
  it('match the files in brand/logo/svg', () => {
    expect(logoShape).toEqual(fileShape('vertex-logo.svg'));
    expect(markShape).toEqual(fileShape('vertex-mark.svg'));
  });
});
