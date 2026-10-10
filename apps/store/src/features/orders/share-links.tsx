'use client';

import {
  maskFieldValue,
  type Order,
  type PublicShare,
  type ReceiptPlayerDisplay,
  type ShareLink,
} from '@vertex-digital/contracts';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vertex-digital/ui/components/alert-dialog';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { Switch } from '@vertex-digital/ui/components/switch';
import { DownloadIcon, GiftIcon, LinkIcon, Share2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { CopyButton } from '@/features/deposits/copy-button';
import { ShareCard } from '@/features/shares/share-card';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { createGiftLink, revokeShareLink, saveReceiptLink } from './requests';

/** Rule RC1: what a share may show; never a reservation waiting for balance or a cancel. */
export function shareable(order: Pick<Order, 'stage'>): boolean {
  return order.stage !== 'awaiting_balance' && order.stage !== 'cancelled';
}

/** The token at the end of a share link's URL (`…/g/<token>`, `…/r/<token>`). */
export function shareToken(link: Pick<ShareLink, 'url'>): string {
  return link.url.split('/').pop() ?? '';
}

/** Rule SH2: the image of a link, served by the API on the store's origin. */
export function shareImage(link: Pick<ShareLink, 'url'>, format: 'og' | 'square'): string {
  return `/api/shares/${encodeURIComponent(shareToken(link))}/image?format=${format}`;
}

const SHARE_STAGES = {
  awaiting_balance: 'processing',
  processing: 'processing',
  delayed: 'processing',
  delivered: 'delivered',
  partially_refunded: 'partially_delivered',
  refunded: 'not_delivered',
  cancelled: 'processing',
} as const satisfies Record<Order['stage'], PublicShare['stage']>;

/**
 * The receipt as its page will show it with these choices (rule RC1's live preview), built from
 * the order the customer already sees: never a code, an email, a phone or a name.
 */
export function receiptPreview(
  order: Order,
  showPrice: boolean,
  playerDisplay: ReceiptPlayerDisplay,
): PublicShare {
  const finished = ['delivered', 'partially_refunded', 'refunded'].includes(order.stage);
  return {
    kind: 'receipt',
    orderNumber: order.number,
    game: { nameAr: order.game.nameAr, nameEn: '', cover: order.game.cover, accentColor: null },
    product: { nameAr: order.product.nameAr, kind: order.product.kind, gameAmount: null },
    quantity: order.quantity,
    deliveredQuantity: order.deliveredQuantity,
    stage: SHARE_STAGES[order.stage],
    paidAt: order.timeline.find((entry) => entry.step === 'paid')?.at ?? order.createdAt,
    finishedAt: finished ? (order.timeline.at(-1)?.at ?? null) : null,
    price: showPrice
      ? { totalUsdUnits: order.totalUsdUnits, refundedUsdUnits: order.refundedUsdUnits }
      : null,
    fields: order.fields
      .filter((field) => field.value)
      .map((field) => ({
        label: field.labelAr,
        value: playerDisplay === 'full' ? field.value : maskFieldValue(field.value),
      })),
    gift: null,
  };
}

/**
 * Copy, share (the Web Share API, falling back to copying), the square image to download, and
 * the revocation after a confirmation (rules GF4, RC3).
 */
function LinkActions({
  order,
  link,
  onChange,
}: {
  order: Order;
  link: ShareLink;
  onChange: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copied, setCopied] = useState(false);

  async function share() {
    try {
      if (navigator.share) return await navigator.share({ url: link.url });
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      // The customer closed the share sheet: nothing to do.
    }
  }

  async function revoke() {
    setFailure(null);
    setBusy(true);
    const result = await revokeShareLink(order.id, link.id);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) return setFailure(result.reason);
    await onChange();
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-md bg-muted px-3 py-2 text-sm break-all" dir="ltr">
        {link.url}
      </p>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={link.url} label={t('orders.share.copy')} />
        <Button variant="outline" size="xl" className="px-3" onClick={() => void share()}>
          <Share2Icon aria-hidden="true" />
          {copied ? t('deposits.copied') : t('orders.share.share')}
        </Button>
        <Button
          variant="outline"
          size="xl"
          className="px-3"
          render={<a href={shareImage(link, 'square')} download={`${order.number}.png`} />}
        >
          <DownloadIcon aria-hidden="true" />
          {t('orders.share.download')}
        </Button>
        <Button
          variant="ghost"
          size="xl"
          className="px-3 text-destructive-text"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          {t('orders.share.revoke')}
        </Button>
      </div>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('orders.share.revokeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('orders.share.revokeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="xl" />}>
              {t('orders.share.keep')}
            </AlertDialogClose>
            <Button variant="destructive" size="xl" disabled={busy} onClick={() => void revoke()}>
              {t('orders.share.revokeConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The gift (rules GF4, GF5): the sender and the message, the live gift link with its image, or
 * "رابط جديد" after a revocation. A reservation gets its link when it is paid.
 */
export function GiftSection({ order, onChange }: { order: Order; onChange: () => Promise<void> }) {
  const link = order.shareLinks.find((item) => item.kind === 'gift') ?? null;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function create() {
    setFailure(null);
    setBusy(true);
    const result = await createGiftLink(order.id);
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    await onChange();
  }

  return (
    <Card className="gap-4">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <GiftIcon className="size-5" aria-hidden="true" />
        {t('orders.gift.title')}
      </h2>
      {order.gift?.senderName && (
        <p className="text-base">{t('orders.gift.from', { name: order.gift.senderName })}</p>
      )}
      {order.gift?.message && (
        <p className="rounded-lg bg-muted p-3 text-base whitespace-pre-line break-words">
          {order.gift.message}
        </p>
      )}
      {!shareable(order) ? (
        <p className="text-sm text-muted-foreground">{t('orders.gift.afterPayment')}</p>
      ) : link ? (
        <>
          <p className="text-sm text-muted-foreground">{t('orders.gift.linkHint')}</p>
          {/* biome-ignore lint/performance/noImgElement: the API renders the image (rule SH2). */}
          <img
            src={shareImage(link, 'og')}
            alt={t('orders.gift.imageAlt')}
            width={1200}
            height={630}
            className="h-auto w-full rounded-lg border border-border"
          />
          <LinkActions order={order} link={link} onChange={onChange} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('orders.gift.noLink')}</p>
          <Button size="xl" className="self-start" disabled={busy} onClick={() => void create()}>
            <LinkIcon aria-hidden="true" />
            {t('orders.share.newLink')}
          </Button>
        </>
      )}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
    </Card>
  );
}

/**
 * "مشاركة الإيصال" (rules RC1–RC3): a bottom sheet with the two choices (the price, on; the ID,
 * masked or in full) and a live preview, then the link with copy, share, download and revoke.
 * Changing a choice later updates the live link (same token).
 */
export function ReceiptSheet({
  order,
  open,
  onOpenChange,
  onChange,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const link = order.shareLinks.find((item) => item.kind === 'receipt') ?? null;
  const [showPrice, setShowPrice] = useState(link?.showPrice ?? true);
  const [playerDisplay, setPlayerDisplay] = useState<ReceiptPlayerDisplay>(
    link?.playerDisplay ?? 'masked',
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const priceId = useId();
  const changed = !link || link.showPrice !== showPrice || link.playerDisplay !== playerDisplay;

  async function save() {
    setFailure(null);
    setBusy(true);
    const result = await saveReceiptLink(order.id, { showPrice, playerDisplay });
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    await onChange();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full max-w-2xl gap-4 bg-surface p-5 pb-8">
        <SheetTitle className="text-lg font-bold">{t('orders.receipt.title')}</SheetTitle>
        <label htmlFor={priceId} className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-base">{t('orders.receipt.showPrice')}</span>
          <Switch id={priceId} checked={showPrice} onCheckedChange={setShowPrice} />
        </label>
        {order.fields.some((field) => field.value) && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-base">{t('orders.receipt.player')}</span>
            <div className="flex gap-2">
              {(['masked', 'full'] as const).map((display) => (
                <Button
                  key={display}
                  variant={playerDisplay === display ? 'primary' : 'outline'}
                  size="xl"
                  className="px-4"
                  aria-pressed={playerDisplay === display}
                  onClick={() => setPlayerDisplay(display)}
                >
                  {t(`orders.receipt.displays.${display}`)}
                </Button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t('orders.receipt.preview')}</p>
          <ShareCard share={receiptPreview(order, showPrice, playerDisplay)} />
        </div>
        {(changed || !link) && (
          <Button size="xl" disabled={busy} onClick={() => void save()}>
            <LinkIcon aria-hidden="true" />
            {t(link ? 'orders.receipt.update' : 'orders.receipt.create')}
          </Button>
        )}
        {failure && <FormAlert>{errorText(failure)}</FormAlert>}
        {link && <LinkActions order={order} link={link} onChange={onChange} />}
      </SheetContent>
    </Sheet>
  );
}
