import { formatUsd, type StockLevel, type SupplierOffer } from '@vertex-digital/contracts';
import { Badge, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatSince, ltr } from '../../lib/format';

/** S18 DC1: basis points as a percent with up to 2 decimals (`200` → `2%`, `125` → `1.25%`). */
export const percentOfBp = (bp: number) =>
  `${Math.trunc(bp / 100)}${
    bp % 100 === 0
      ? ''
      : `.${String(bp % 100)
          .padStart(2, '0')
          .replace(/0$/, '')}`
  }%`;

/*
 * An offer's supplier fields as the offers table, a category's packs and the import dialogs show
 * them (S16 SF1, SF2). Supplier text (names, labels, options) is rendered as text.
 */

const STOCK_TONES: Record<StockLevel, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success',
  unlimited: 'success',
  low: 'warning',
  out: 'danger',
};

/**
 * Rule SF2's chip: "مخزون منخفض" or "نفد", the reported figure, or "غير محدود"; with `quiet`
 * (a pack or a route) nothing while the stock is fine.
 */
export function StockChip({
  level,
  stock,
  quiet = false,
}: {
  level: StockLevel;
  stock?: number | null;
  quiet?: boolean;
}) {
  const { t } = useTranslation();
  if (quiet && (level === 'ok' || level === 'unlimited')) return null;
  const label =
    level === 'unlimited'
      ? t('suppliers.stock.unlimited')
      : level === 'out'
        ? t('suppliers.stock.out')
        : level === 'low'
          ? stock !== null && stock !== undefined
            ? t('suppliers.stock.lowCount', { count: stock })
            : t('suppliers.stock.low')
          : t('suppliers.stock.count', { count: stock ?? 0 });
  return <Badge tone={STOCK_TONES[level]}>{label}</Badge>;
}

/** The cost and its freshness (rule SY5), the original price and discount (SF1), or the raw value. */
export function OfferCost({
  offer,
}: {
  offer: Pick<
    SupplierOffer,
    | 'costUsdUnits'
    | 'costRaw'
    | 'costStale'
    | 'costConfirmedAt'
    | 'originalCostUsdUnits'
    | 'discountPercent'
  > &
    Partial<Pick<SupplierOffer, 'discountBp'>>;
}) {
  const { t } = useTranslation();
  if (offer.costUsdUnits === null) {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge tone="warning">{t('suppliers.offers.costUnknown')}</Badge>
        {offer.costRaw && (
          <bdi dir="ltr" className="text-xs text-muted-foreground">
            {offer.costRaw}
          </bdi>
        )}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5">
      <bdi dir="ltr" className="font-medium tabular-nums">
        {formatUsd(offer.costUsdUnits)}
      </bdi>
      <OriginalPrice
        originalCostUsdUnits={offer.originalCostUsdUnits}
        discountPercent={offer.discountPercent}
        discountBp={offer.discountBp ?? null}
      />
      {offer.costStale ? (
        <Badge tone="warning">{t('suppliers.offers.costStale')}</Badge>
      ) : (
        offer.costConfirmedAt && (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(offer.costConfirmedAt)}
          >
            {formatSince(offer.costConfirmedAt)}
          </span>
        )
      )}
    </span>
  );
}

/**
 * Rule SF1: the supplier's price before its discount, shown only with a discount; S18 DC1: the
 * supplier's own figure (WDG's VIP discount) as "خصم VIP" when it gives one.
 */
export function OriginalPrice({
  originalCostUsdUnits,
  discountPercent,
  discountBp = null,
}: {
  originalCostUsdUnits: number | null;
  discountPercent: number | null;
  discountBp?: number | null;
}) {
  const { t } = useTranslation();
  if (discountBp === null && (originalCostUsdUnits === null || discountPercent === null)) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {originalCostUsdUnits !== null && discountPercent !== null && (
        <bdi dir="ltr" className="tabular-nums line-through">
          {formatUsd(originalCostUsdUnits)}
        </bdi>
      )}
      <Badge tone="gold">
        {discountBp !== null
          ? t('suppliers.offers.vipDiscount', { percent: ltr(percentOfBp(discountBp)) })
          : t('suppliers.offers.discount', { percent: ltr(`${discountPercent}%`) })}
      </Badge>
    </span>
  );
}

/** S18: when the supplier last listed the offer. */
export function LastSeen({ at }: { at: string }) {
  const { t } = useTranslation();
  return (
    <span className="text-xs text-muted-foreground" title={formatDateTime(at)}>
      {t('suppliers.offers.lastSeen', { since: formatSince(at) })}
    </span>
  );
}

/** The fields the supplier asks for, with their labels, types and options (SF1). */
export function OfferFields({
  offer,
}: {
  offer: Pick<SupplierOffer, 'fieldSpecs' | 'requiredFields'>;
}) {
  const { t } = useTranslation();
  const specs = offer.fieldSpecs;
  if (!specs) {
    return offer.requiredFields?.length ? (
      <bdi dir="ltr" className="text-xs">
        {offer.requiredFields.join(', ')}
      </bdi>
    ) : (
      <span className="text-sm text-muted-foreground">{t('suppliers.offers.noFields')}</span>
    );
  }
  if (specs.length === 0) {
    return <span className="text-sm text-muted-foreground">{t('suppliers.offers.noFields')}</span>;
  }
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {specs.map((spec) => (
        <li key={spec.key} className="flex flex-wrap items-center gap-1.5">
          <bdi className="font-medium">{spec.label || spec.key}</bdi>
          <bdi dir="ltr" className="text-muted-foreground">
            {spec.key}
          </bdi>
          <Badge tone="outline">{t(`suppliers.offers.fieldTypes.${spec.type}`)}</Badge>
          {spec.options && spec.options.length > 0 && (
            // S18: the select's choices, as the supplier labels and sends them.
            <Popover>
              <PopoverTrigger className="text-muted-foreground underline underline-offset-4">
                {t('suppliers.offers.options', { count: spec.options.length })}
              </PopoverTrigger>
              <PopoverContent className="max-h-72 w-72 overflow-y-auto">
                <PopoverTitle>{spec.label || spec.key}</PopoverTitle>
                <ul className="flex flex-col gap-1 text-sm">
                  {spec.options.map((option) => (
                    <li key={option.value} className="flex items-center justify-between gap-3">
                      <bdi>{option.label}</bdi>
                      <bdi dir="ltr" className="text-xs text-muted-foreground">
                        {option.value}
                      </bdi>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Rule SC3: an offer the store cannot order yet, and an ignored one (SC6). */
export function OfferMarks({
  offer,
}: {
  offer: Pick<SupplierOffer, 'unsupportedReason' | 'ignoredAt' | 'missingSince'>;
}) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap gap-1.5">
      {offer.unsupportedReason && (
        <Badge tone="danger">{t(`suppliers.offers.unsupported.${offer.unsupportedReason}`)}</Badge>
      )}
      {offer.ignoredAt && <Badge tone="neutral">{t('suppliers.offers.ignored')}</Badge>}
      {offer.missingSince && (
        <Badge tone="danger">
          {t('suppliers.offers.missingSince', { since: formatSince(offer.missingSince) })}
        </Badge>
      )}
    </span>
  );
}
