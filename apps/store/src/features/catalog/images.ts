import { CATALOG_IMAGE_WIDTHS, type CatalogImage } from '@vertex-digital/contracts';

/**
 * A catalog image's `src` and `srcset` (S09 rule SF5): the public route serves each of
 * `CATALOG_IMAGE_WIDTHS` as WebP, fitted to that width and never upscaled, so a width above the
 * original is listed once, at the original's size.
 */
export function imageSources(image: CatalogImage): { src: string; srcSet: string } {
  const entries: string[] = [];
  const seen = new Set<number>();
  for (const width of CATALOG_IMAGE_WIDTHS) {
    const actual = Math.min(width, image.width);
    if (seen.has(actual)) continue;
    seen.add(actual);
    entries.push(`${image.url}?w=${width} ${actual}w`);
  }
  return { src: `${image.url}?w=${CATALOG_IMAGE_WIDTHS[1]}`, srcSet: entries.join(', ') };
}
