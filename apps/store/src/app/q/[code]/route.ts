import { connection, type NextRequest, NextResponse } from 'next/server';
import {
  QUICK_LINK_COOKIE,
  QUICK_LINK_COOKIE_SECONDS,
  quickLinkCookieValue,
} from '@/features/quick-links/handoff';
import { resolveQuickLink } from '@/features/quick-links/resolve';
import { storeUrl } from '@/lib/server-env';

/**
 * A direct buy link (S22 DL1, DL2): `307` to the pack, its game or the home page. The campaign and
 * the code reach the game page in a short cookie, never in the URL after the redirect.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  await connection();
  const { code } = await params;
  const target = await resolveQuickLink(
    code,
    request.nextUrl.searchParams.get('c'),
    request.headers.get('x-forwarded-for'),
  );
  // A relative location: the store's own path, whatever host the request named.
  const response = new NextResponse(null, {
    status: 307,
    headers: { location: target.path, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
  if (target.open) {
    response.cookies.set(QUICK_LINK_COOKIE, quickLinkCookieValue(target.open), {
      maxAge: QUICK_LINK_COOKIE_SECONDS,
      path: '/games',
      sameSite: 'lax',
      secure: storeUrl().startsWith('https:'),
    });
  }
  return response;
}
