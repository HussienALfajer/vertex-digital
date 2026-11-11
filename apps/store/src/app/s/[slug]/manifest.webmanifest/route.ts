import type { ShopManifest } from '@vertex-digital/contracts';
import { connection } from 'next/server';
import { isShopSlug, shopScope } from '@/features/shop/paths';
import { API_READ_TIMEOUT_MS, apiInternalUrl, CACHED_READ_HEADERS } from '@/lib/server-env';

type Context = { params: Promise<{ slug: string }> };

/**
 * `/s/<slug>/manifest.webmanifest` (S26 SP1): the shop as an installable app, its name, icons and
 * brand color, opening and staying in the shop (`scope` is the shop's). From the API's public
 * manifest data; an old slug sends the browser to the current shop's manifest (edge case 16).
 */
export async function GET(_request: Request, { params }: Context) {
  await connection();
  const { slug } = await params;
  if (!isShopSlug(slug)) return new Response(null, { status: 404 });
  const response = await fetch(`${apiInternalUrl()}/api/shops/${slug}/manifest`, {
    headers: CACHED_READ_HEADERS,
    redirect: 'manual',
    signal: AbortSignal.timeout(API_READ_TIMEOUT_MS),
  });
  if (response.status === 301) {
    const moved = (await response.json().catch(() => null)) as { slug?: unknown } | null;
    if (typeof moved?.slug !== 'string' || !isShopSlug(moved.slug)) {
      return new Response(null, { status: 502 });
    }
    return Response.redirect(new URL(`/s/${moved.slug}/manifest.webmanifest`, _request.url), 301);
  }
  if (response.status === 404) return new Response(null, { status: 404 });
  if (!response.ok) return new Response(null, { status: 502 });
  const shop = (await response.json()) as ShopManifest;
  const scope = shopScope(shop.slug);
  const manifest = {
    id: scope,
    start_url: scope,
    scope,
    display: 'standalone',
    lang: 'ar',
    dir: 'rtl',
    name: shop.name,
    short_name: shop.shortName,
    background_color: shop.brandColor,
    theme_color: shop.brandColor,
    icons: shop.icons.map((icon) => ({
      src: icon.url,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: 'any',
    })),
  };
  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Robots-Tag': 'noindex',
    },
  });
}
