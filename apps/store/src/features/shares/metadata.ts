import type { ShareKind } from '@vertex-digital/contracts';
import type { Metadata } from 'next';
import { t } from '@/lib/i18n';
import { storeUrl } from '@/lib/server-env';

/**
 * Rules SH2, SH5: never indexed, no referrer sent onwards (a link's token must not leak to the
 * sites it links to), and the `og` image as the link preview. Built without reading the share, so
 * a preview costs one image request, not two API reads.
 */
export async function shareMetadata(
  kind: ShareKind,
  params: Promise<{ token: string }>,
): Promise<Metadata> {
  const { token } = await params;
  const title = t(kind === 'gift' ? 'share.gift.metaTitle' : 'share.receipt.metaTitle');
  const image = /^[A-Za-z0-9_-]{22}$/.test(token)
    ? [{ url: `${storeUrl()}/api/shares/${token}/image?format=og`, width: 1200, height: 630 }]
    : undefined;
  return {
    title: { absolute: title },
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
    openGraph: { title, ...(image && { images: image }) },
    twitter: { card: 'summary_large_image' },
  };
}
