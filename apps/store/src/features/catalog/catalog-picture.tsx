import type { CatalogImage } from '@vertex-digital/contracts';
import { imageSources } from './images';

/**
 * A catalog image inside the brand frame (1 px border, lg radius; brand/identity.md §6), at the
 * widths of rule SF5. `sizes` says how wide it is drawn, so the browser picks the smallest file.
 * Decorative unless `alt` is given: the game's name is always written next to it.
 */
export function CatalogPicture({
  image,
  sizes,
  alt = '',
  priority = false,
  className,
}: {
  image: CatalogImage;
  sizes: string;
  alt?: string;
  priority?: boolean;
  className?: string;
}) {
  const { src, srcSet } = imageSources(image);
  return (
    // biome-ignore lint/performance/noImgElement: the API resizes; next/image would resize again.
    <img
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      alt={alt}
      width={image.width}
      height={image.height}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      className={`rounded-lg border border-border bg-muted object-cover ${className ?? ''}`}
    />
  );
}
