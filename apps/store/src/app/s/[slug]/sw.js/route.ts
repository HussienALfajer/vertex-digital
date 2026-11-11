import { connection } from 'next/server';
import { serviceWorkerScript } from '@/features/pwa/service-worker';
import { getShopStorefront } from '@/features/shop/data';
import { isShopSlug, shopApi, shopScope } from '@/features/shop/paths';
import { t } from '@/lib/i18n';

type Context = { params: Promise<{ slug: string }> };

/**
 * `/s/<slug>/sw.js` (S26 SP1): the shop's own worker, scoped to the shop: its pushes show the
 * shop's icon and open the shop's pages only. Never cached, as the store's worker (SW1).
 *
 * Edge case 16: under an old slug it serves the shop's current worker, still allowed at the old
 * scope, so a device that installed the shop before the slug changed keeps its worker and its
 * pushes (a 404 here would unregister them), and its links open the shop's current pages.
 */
export async function GET(_request: Request, { params }: Context) {
  await connection();
  const { slug } = await params;
  if (!isShopSlug(slug)) return new Response(null, { status: 404 });
  let read = await getShopStorefront(slug);
  if (read?.status === 'moved') read = await getShopStorefront(read.slug);
  if (read?.status !== 'found') return new Response(null, { status: 404 });
  const { shop } = read.data;
  const icon = shopApi(shop.slug, '/icon?size=192');
  const script = serviceWorkerScript({
    version: process.env.STORE_BUILD_ID ?? 'development',
    icon,
    badge: icon,
    fallbackBody: t('push.fallback'),
    shop: { scope: shopScope(shop.slug), name: shop.name },
  });
  return new Response(script, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      // The scope the browser registered: the requested slug's, old or current.
      'Service-Worker-Allowed': shopScope(slug),
    },
  });
}
