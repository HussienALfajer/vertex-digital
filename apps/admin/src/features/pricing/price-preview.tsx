import { useQuery } from '@tanstack/react-query';
import {
  formatSyp,
  formatUsd,
  type MarginScope,
  type PricingPreviewRequest,
  SAVINGS_WARNING_PERCENT,
} from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { previewQuery } from './pricing.queries';
import { formatPercentBp } from './pricing-format';

/**
 * The price, margin and SYP price for a cost under a rule (rule PR10, PR3–PR8), with the savings
 * against a product's official price (PR7) and where the rule comes from; nothing until the
 * request is valid.
 */
export function PricePreview({ request }: { request: PricingPreviewRequest | null }) {
  const { t } = useTranslation();
  const preview = useQuery(previewQuery(request));
  if (!request) {
    return <p className="text-sm text-muted-foreground">{t('pricing.preview.invalid')}</p>;
  }
  if (preview.isPending) return <Skeleton className="h-28 w-full" aria-hidden="true" />;
  if (preview.isError) return <FormAlert>{errorMessage(t, preview.error)}</FormAlert>;
  const data = preview.data;
  const savingsWarning = (data.savings?.percent ?? 0) > SAVINGS_WARNING_PERCENT;
  return (
    <div className="flex flex-col gap-3" aria-live="polite" data-testid="price-preview">
      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-sm sm:grid-cols-4">
        <Fact label={t('pricing.preview.cost')}>
          <bdi dir="ltr">{formatUsd(data.costUsdUnits)}</bdi>
        </Fact>
        <Fact label={t('pricing.preview.price')} strong>
          <bdi dir="ltr">{formatUsd(data.priceUsdUnits)}</bdi>
        </Fact>
        <Fact label={t('pricing.preview.margin')}>
          <bdi dir="ltr">{formatUsd(data.marginUsdUnits)}</bdi>{' '}
          <span className="text-muted-foreground">
            (<bdi dir="ltr">{formatPercentBp(data.marginBp)}%</bdi>)
          </span>
        </Fact>
        <Fact label={t('pricing.preview.syp')}>
          {data.priceSypUnits === null ? (
            <span className="text-muted-foreground">{t('pricing.preview.noRate')}</span>
          ) : (
            t('pricing.preview.sypAmount', { amount: formatSyp(data.priceSypUnits) })
          )}
        </Fact>
      </dl>
      <div className="flex flex-col gap-1 text-sm">
        {data.ruleScope && (
          <p>{t('pricing.preview.from', { source: ruleSource(t, data.ruleScope) })}</p>
        )}
        {data.officialPriceUsdUnits !== null && (
          <p>
            {data.savings
              ? data.savings.percent === null
                ? t('pricing.preview.savingsAmount', {
                    amount: ltr(formatUsd(data.savings.amountUsdUnits)),
                    official: ltr(formatUsd(data.officialPriceUsdUnits)),
                  })
                : t('pricing.preview.savings', {
                    amount: ltr(formatUsd(data.savings.amountUsdUnits)),
                    percent: ltr(`${data.savings.percent}%`),
                    official: ltr(formatUsd(data.officialPriceUsdUnits)),
                  })
              : t('pricing.preview.noSavings', {
                  official: ltr(formatUsd(data.officialPriceUsdUnits)),
                })}
          </p>
        )}
        {savingsWarning && (
          <p className="text-status-warning-foreground">{t('pricing.preview.savingsWarning')}</p>
        )}
      </div>
    </div>
  );
}

function Fact({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? 'text-lg font-bold tabular-nums' : 'font-medium tabular-nums'}>
        {children}
      </dd>
    </div>
  );
}

/** Where a rule comes from: "القاعدة العامة", "قاعدة الفئة"… */
export const ruleSource = (t: TFunction, scope: MarginScope) => t(`pricing.sources.${scope}`);
