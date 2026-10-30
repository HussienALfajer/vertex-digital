import type { CatalogImage, CatalogImageWidth } from '@vertex-digital/contracts';

/**
 * `CATALOG_IMAGE_WIDTHS` of the contracts (the test checks it): `CatalogPicture` is a client
 * component on every page, and the contracts' value import would bring zod into the first load.
 */
export const IMAGE_WIDTHS: readonly CatalogImageWidth[] = [160, 320, 640, 1280];

/**
 * A catalog image's `src` and `srcset` (S09 rule SF5): the public route serves each of
 * `CATALOG_IMAGE_WIDTHS` as WebP, fitted to that width and never upscaled, so a width above the
 * original is listed once, at the original's size.
 */
export function imageSources(image: Pick<CatalogImage, 'url' | 'width'>): {
  src: string;
  srcSet: string;
} {
  const entries: string[] = [];
  const seen = new Set<number>();
  for (const width of IMAGE_WIDTHS) {
    const actual = Math.min(width, image.width);
    if (seen.has(actual)) continue;
    seen.add(actual);
    entries.push(`${image.url}?w=${width} ${actual}w`);
  }
  return { src: `${image.url}?w=${IMAGE_WIDTHS[1]}`, srcSet: entries.join(', ') };
}
