import { formatUsd, type StockLevel, type SupplierOffer } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatSince } from '../../lib/format';

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
  >;
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

/** Rule SF1: the supplier's price before its discount, shown only with a discount. */
export function OriginalPrice({
  originalCostUsdUnits,
  discountPercent,
}: {
  originalCostUsdUnits: number | null;
  discountPercent: number | null;
}) {
  const { t } = useTranslation();
  if (originalCostUsdUnits === null || discountPercent === null) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <bdi dir="ltr" className="tabular-nums line-through">
        {formatUsd(originalCostUsdUnits)}
      </bdi>
      <Badge tone="gold">{t('suppliers.offers.discount', { percent: discountPercent })}</Badge>
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
            <span className="text-muted-foreground">
              {t('suppliers.offers.options', { count: spec.options.length })}
            </span>
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
