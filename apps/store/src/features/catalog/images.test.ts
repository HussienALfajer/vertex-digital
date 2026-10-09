import { describe, expect, it } from 'vitest';
import { imageSources } from './images';

const image = (width: number) => ({
  id: '0199c3a4-0000-7000-8000-000000000001',
  url: '/api/catalog/images/0199c3a4-0000-7000-8000-000000000001',
  width,
  height: width,
});

describe('imageSources (rule SF5)', () => {
  it('lists every width of a large image', () => {
    const { src, srcSet } = imageSources(image(1600));
    expect(src).toBe(`${image(1).url}?w=320`);
    expect(srcSet.split(', ')).toEqual([
      `${image(1).url}?w=160 160w`,
      `${image(1).url}?w=320 320w`,
      `${image(1).url}?w=640 640w`,
      `${image(1).url}?w=1280 1280w`,
    ]);
  });

  it('lists a width above a small original once, at its size', () => {
    expect(imageSources(image(500)).srcSet.split(', ')).toEqual([
      `${image(1).url}?w=160 160w`,
      `${image(1).url}?w=320 320w`,
      `${image(1).url}?w=640 500w`,
    ]);
  });
});
