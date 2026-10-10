import type { ShareKind } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { LinkIcon } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { storeUrl } from '@/lib/server-env';
import { readShare } from './data';
import { ShareActions } from './share-actions';
import { ShareCard } from './share-card';

export const SHARE_PATHS = { gift: 'g', receipt: 'r' } as const satisfies Record<ShareKind, string>;

/**
 * A gift (`/g/<token>`, rule GF5) or a receipt (`/r/<token>`, rule RC2): one centered card at
 * phone width with the image to download and "مشاركة"; a gift adds the store's invitation. An
 * unknown or revoked link says "هذا الرابط غير متاح" with a link home. Rendered per request.
 */
export async function SharePage({
  kind,
  params,
}: {
  kind: ShareKind;
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await readShare(kind, token);
  if (!share) {
    return (
      <EmptyState
        icon={<LinkIcon />}
        title={t('share.unavailableTitle')}
        description={t('share.unavailableBody')}
        action={
          <Button size="xl" render={<Link href="/" />}>
            {t('share.home')}
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <ShareCard share={share} verifyUrl={`${storeUrl()}/${SHARE_PATHS[kind]}/${token}`} />
      <ShareActions
        token={token}
        fileName={kind === 'gift' ? 'vertex-gift.png' : `${share.orderNumber ?? 'receipt'}.png`}
      />
      {kind === 'gift' && (
        <Button variant="ghost" size="xl" className="self-center" render={<Link href="/" />}>
          {t('share.gift.invite')}
        </Button>
      )}
    </div>
  );
}

export function ShareSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-hidden="true">
      <Skeleton className="h-96 w-full rounded-xl" />
      <Skeleton className="mx-auto h-11 w-64" />
    </div>
  );
}
