import { SHOP_DARK_BACKGROUND, SHOP_LIGHT_BACKGROUND } from '@vertex-digital/contracts';
import { themeHex } from '@vertex-digital/ui/theme-hex';
import { tsa } from './i18n';

/*
 * The request's and the settings' live preview (S26 Screens): the shop's header and a pack card,
 * in both themes at once. The page itself is in one theme, so each frame draws its theme's colors
 * from the design system's own values (`theme-hex`, the contracts' backgrounds), not its tokens.
 */

const THEMES = {
  light: {
    label: 'request.previewLight',
    background: SHOP_LIGHT_BACKGROUND,
    surface: themeHex['neutral-100'],
    border: themeHex['neutral-200'],
    text: themeHex['neutral-900'],
    muted: themeHex['neutral-600'],
  },
  dark: {
    label: 'request.previewDark',
    background: SHOP_DARK_BACKGROUND,
    surface: themeHex['green-800'],
    border: themeHex['green-800'],
    text: themeHex['neutral-100'],
    muted: themeHex['neutral-300'],
  },
} as const;

export function ShopPreview({
  name,
  color,
  logoUrl,
}: {
  name: string;
  /** A valid brand color, or null while the field holds none: the store's green stands in. */
  color: string | null;
  logoUrl: string | null;
}) {
  const brand = color ?? themeHex['green-800'];
  return (
    <div className="flex flex-col gap-2" data-testid="shop-preview">
      <span className="text-sm text-muted-foreground">{tsa('request.preview')}</span>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        {(['light', 'dark'] as const).map((theme) => {
          const colors = THEMES[theme];
          return (
            <figure key={theme} className="flex flex-col gap-1">
              <div
                className="flex flex-col gap-3 overflow-hidden rounded-lg border p-3"
                style={{
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                  color: colors.text,
                }}
              >
                <div className="flex items-center gap-2">
                  {logoUrl ? (
                    // biome-ignore lint/performance/noImgElement: the merchant's own logo, served by the API.
                    <img
                      src={logoUrl}
                      alt=""
                      className="size-9 rounded-md border bg-white object-contain"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex size-9 items-center justify-center rounded-md font-bold text-white"
                      style={{ backgroundColor: brand }}
                    >
                      {name.trim().charAt(0)}
                    </span>
                  )}
                  <bdi className="truncate font-bold">{name}</bdi>
                </div>
                <div
                  className="flex items-center justify-between gap-2 rounded-md border p-3"
                  style={{ backgroundColor: colors.surface, borderColor: colors.border }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-bold">{tsa('request.previewPack')}</span>
                    <span className="text-xs" style={{ color: colors.muted }}>
                      {tsa('request.previewGame')}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-sm font-bold tabular-nums">
                      {tsa('request.previewPrice')}
                    </span>
                    <span
                      className="rounded-md px-3 py-1 text-xs font-bold text-white"
                      style={{ backgroundColor: brand }}
                    >
                      {tsa('request.previewBuy')}
                    </span>
                  </span>
                </div>
                <span className="text-center text-[0.65rem]" style={{ color: colors.muted }}>
                  {tsa('request.previewPowered')}
                </span>
              </div>
              <figcaption className="text-xs text-muted-foreground">{tsa(colors.label)}</figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
