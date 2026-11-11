import type { CSSProperties } from 'react';

/**
 * S26 ST1: the shop's one brand color as the design system's primary in both themes: buttons,
 * the slide, focus rings and the selected pack. ST1 accepts a color only when white text on it
 * reaches 4.5:1 and it reaches 3:1 against both theme backgrounds, so white text and the color as
 * an outline stay readable in light and dark. The shop's other tokens stay the design system's.
 */
export function brandStyle(color: string): CSSProperties {
  return {
    '--shop-brand': color,
    '--primary': color,
    '--primary-hover': `color-mix(in oklab, ${color} 85%, black)`,
    '--primary-foreground': 'var(--color-white)',
    '--ring': color,
  } as CSSProperties;
}
