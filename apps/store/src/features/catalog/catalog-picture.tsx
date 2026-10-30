'use client';

import type { CatalogImage } from '@vertex-digital/contracts';
import { VertexMark } from '@vertex-digital/ui/brand/logo';
import { useEffect, useRef, useState } from 'react';
import { imageSources } from './images';

/** A refused image (a rate limit, a lost connection) is asked for once more after this long. */
const RETRY_MS = 3_000;

/**
 * A catalog image inside the brand frame (1 px border, lg radius; brand/identity.md §6), at the
 * widths of rule SF5. `sizes` says how wide it is drawn, so the browser picks the smallest file.
 * Decorative unless `alt` is given: the game's name is always written next to it. A failed image
 * is tried once more, then the Vertex mark takes its place at the same size: never the browser's
 * broken-image icon.
 */
export function CatalogPicture({
  image,
  sizes,
  alt = '',
  priority = false,
  className,
}: {
  image: Pick<CatalogImage, 'url' | 'width' | 'height'>;
  sizes: string;
  alt?: string;
  priority?: boolean;
  className?: string;
}) {
  const { src, srcSet } = imageSources(image);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const element = useRef<HTMLImageElement>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function onError() {
    clearTimeout(retry.current);
    if (attempt > 0) return setFailed(true);
    retry.current = setTimeout(() => setAttempt(1), RETRY_MS);
  }

  // An image that failed before this component hydrated fired its `error` with nobody listening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the server's element.
  useEffect(() => {
    const current = element.current;
    if (current?.complete && current.naturalWidth === 0) onError();
    return () => clearTimeout(retry.current);
  }, []);

  if (failed) {
    return (
      <span
        {...(alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': true })}
        style={{ aspectRatio: `${image.width} / ${image.height}` }}
        className={`flex items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground ${className ?? ''}`}
      >
        <VertexMark className="w-1/3 max-w-12" />
      </span>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: the API resizes; next/image would resize again.
    <img
      // A new element asks again: the same address on the old one would not.
      key={attempt}
      ref={element}
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      alt={alt}
      width={image.width}
      height={image.height}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      onError={onError}
      className={`rounded-lg border border-border bg-muted object-cover ${className ?? ''}`}
    />
  );
}
