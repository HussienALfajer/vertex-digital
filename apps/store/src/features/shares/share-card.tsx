import { formatUsd, type PublicShare } from '@vertex-digital/contracts';
import { VertexMark } from '@vertex-digital/ui/brand/logo';
import { Badge } from '@vertex-digital/ui/components/badge';
import type { ReactNode } from 'react';
import { accentStyle } from '@/features/catalog/game-card';
import { t } from '@/lib/i18n';
import { LocalTime } from './local-time';

const STAGE_TONES = {
  processing: 'info',
  delivered: 'success',
  partially_delivered: 'warning',
  not_delivered: 'neutral',
} as const satisfies Record<PublicShare['stage'], string>;

/** Rule SH4: "قيد الشحن", "تم الشحن", "تم شحن d من q", "تعذّر الشحن". */
export function shareStageText(
  share: Pick<PublicShare, 'stage' | 'deliveredQuantity' | 'quantity'>,
) {
  return share.stage === 'partially_delivered'
    ? t('share.stages.partially_delivered', {
        delivered: share.deliveredQuantity,
        quantity: share.quantity,
      })
    : t(`share.stages.${share.stage}`);
}

/**
 * The gift or receipt as the public pages show it (S10 rules GF5, RC2), and as the receipt sheet
 * previews it: the brand frame with the game's accent, then only what the owner chose. Every value
 * is rendered as text (ADR 0015); IDs read left to right inside the Arabic text. A server
 * component, so the public pages ship no money code; only the times render in the browser.
 */
export function ShareCard({ share, verifyUrl }: { share: PublicShare; verifyUrl?: string }) {
  const gift = share.kind === 'gift';
  return (
    <article
      style={accentStyle(share.game.accentColor)}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div aria-hidden="true" className="h-2 bg-(--game-accent)" />
      <div className="flex flex-col gap-5 p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-accent-text">
            <VertexMark className="w-7" />
            <span className="text-sm font-bold text-foreground" dir="ltr">
              {t('app.name')}
            </span>
          </span>
          <Badge tone={STAGE_TONES[share.stage]}>{shareStageText(share)}</Badge>
        </div>
        <h2 className="text-2xl font-bold">
          {gift ? t('share.gift.title') : t('share.receipt.title')}
        </h2>
        {gift && share.gift?.senderName && (
          <p className="text-lg">{t('share.gift.from', { name: share.gift.senderName })}</p>
        )}
        {gift && share.gift?.message && (
          <p className="rounded-lg bg-muted p-4 text-base whitespace-pre-line break-words">
            {share.gift.message}
          </p>
        )}
        <div className="flex items-center gap-3">
          {share.game.cover && (
            // biome-ignore lint/performance/noImgElement: catalog images are stored re-encoded and served immutable by the API (S06).
            <img
              src={`${share.game.cover.url}?w=160`}
              alt=""
              width={share.game.cover.width}
              height={share.game.cover.height}
              className="size-14 shrink-0 rounded-lg border border-border object-cover"
            />
          )}
          <div className="flex min-w-0 flex-col">
            <p className="text-lg font-bold break-words">
              <bdi>{share.product.nameAr}</bdi>
              {share.quantity > 1 && (
                <span className="text-muted-foreground"> × {share.quantity}</span>
              )}
            </p>
            <p className="text-sm text-muted-foreground">{share.game.nameAr}</p>
          </div>
        </div>
        <dl className="flex flex-col gap-2 text-sm">
          {share.orderNumber && (
            <Line label={t('share.receipt.number')}>
              <bdi dir="ltr" className="font-medium">
                {share.orderNumber}
              </bdi>
            </Line>
          )}
          {share.fields.map((field) => (
            <Line key={field.label} label={field.label}>
              <bdi dir="ltr" className="font-medium break-all">
                {field.value}
              </bdi>
            </Line>
          ))}
          {!gift && (
            <Line label={t('share.receipt.paidAt')}>
              <LocalTime iso={share.paidAt} />
            </Line>
          )}
          {share.finishedAt && (
            <Line label={t('share.finishedAt')}>
              <LocalTime iso={share.finishedAt} />
            </Line>
          )}
          {share.price && (
            <Line label={t('share.receipt.total')}>
              <bdi dir="ltr" className="font-bold tabular-nums">
                {formatUsd(share.price.totalUsdUnits)}
              </bdi>
            </Line>
          )}
          {share.price && share.price.refundedUsdUnits > 0 && (
            <Line label={t('share.receipt.refunded')}>
              <bdi dir="ltr" className="tabular-nums">
                {formatUsd(share.price.refundedUsdUnits)}
              </bdi>
            </Line>
          )}
        </dl>
        {!gift && verifyUrl && (
          <p className="text-xs text-muted-foreground break-all">
            {t('share.receipt.verify')} <bdi dir="ltr">{verifyUrl.replace(/^https?:\/\//, '')}</bdi>
          </p>
        )}
      </div>
    </article>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}
