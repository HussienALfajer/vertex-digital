/*
 * The few theme colors needed where CSS variables cannot reach: the web app manifest, the
 * `theme-color` meta tag and the store's self-contained offline page (S15). Values copied from
 * `theme.css`, the only other place colors are written; `tokens.test.ts` fails when they differ.
 */
export const themeHex = {
  'green-950': '#031b17',
  'gold-400': '#b9a87a',
  'neutral-100': '#e7efed',
  'neutral-300': '#b8bfbe',
} as const;
