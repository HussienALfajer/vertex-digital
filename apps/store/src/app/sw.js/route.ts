import { connection } from 'next/server';
import { serviceWorkerScript } from '@/features/pwa/service-worker';
import { t } from '@/lib/i18n';
import badge from '../../../../../brand/logo/png/badge-96.png';
import icon from '../../../../../brand/logo/png/icon-192.png';

/**
 * `/sw.js` (S15 SW1): the constant worker script with this build's id, never cached by the
 * browser or nginx so a deploy reaches every device on its next visit.
 */
export async function GET() {
  // Per request: a prerendered route would carry Next's own cache header.
  await connection();
  const script = serviceWorkerScript({
    version: process.env.STORE_BUILD_ID ?? 'development',
    icon: icon.src,
    badge: badge.src,
    fallbackBody: t('push.fallback'),
  });
  return new Response(script, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    },
  });
}
