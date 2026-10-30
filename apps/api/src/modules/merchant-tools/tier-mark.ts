import { type MerchantTier, TIER_NAMES_AR } from '@vertex-digital/contracts';

/*
 * S23 ID1, ID6: the tier's mark in generated images: its Lucide icon (Bronze `Shield`, Silver
 * `Medal`, Gold `Crown`, Diamond `Gem`; ISC licence) stroked in the tier's colour, and the line
 * "تاجر <tier> معتمد من Vertex Digital" (Bronze without the tier). The colours are the tier tokens
 * of `brand/identity.md` on the dark surface.
 */

export const TIER_COLORS = {
  bronze: '#B07A55',
  silver: '#A9B4B2',
  gold: '#B9A87A',
  diamond: '#8FD3C8',
} as const satisfies Record<MerchantTier, string>;

const ICONS: Record<MerchantTier, string> = {
  bronze:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  silver:
    '<path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/>',
  gold: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  diamond:
    '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
};

/** The tier's icon as an SVG of `size` pixels, stroked in its colour. */
export function tierIconSvg(tier: MerchantTier, size: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${TIER_COLORS[tier]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[tier]}</svg>`,
  );
}

/** ID5, ID6: the line under the shop's name. */
export function tierLine(tier: MerchantTier): string {
  return tier === 'bronze'
    ? 'تاجر معتمد من Vertex Digital'
    : `تاجر ${TIER_NAMES_AR[tier]} معتمد من Vertex Digital`;
}
