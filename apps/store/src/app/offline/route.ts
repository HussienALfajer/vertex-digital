import { connection } from 'next/server';
import { offlinePage } from '@/features/pwa/offline-page';

/**
 * `/offline` (S15 SW5): the page the service worker keeps and shows when a navigation fails.
 * Self-contained, never indexed, not in the sitemap.
 */
export async function GET() {
  await connection();
  return new Response(offlinePage(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex',
    },
  });
}
