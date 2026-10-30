/*
 * The few theme colors needed where CSS variables cannot reach: the web app manifest, the
 * `theme-color` meta tag, the store's self-contained offline page (S15) and the panel's printed
 * QR card (S22 DL5, drawn on a canvas), the store's shop sticker (S23 ID8, drawn on a canvas). Values copied from `theme.css`, the only other place
 * colors are written; `tokens.test.ts` fails when they differ.
 */
export const themeHex = {
  'green-800': '#004139',
  'green-950': '#031b17',
  'gold-400': '#b9a87a',
  'gold-700': '#5d4e27',
  'neutral-100': '#e7efed',
  'neutral-200': '#d4dbd9',
  'neutral-300': '#b8bfbe',
  'neutral-600': '#616866',
  'neutral-900': '#222827',
  'tier-bronze-400': '#b07a55',
  'tier-silver-400': '#a9b4b2',
  'tier-diamond-400': '#8fd3c8',
} as const;
