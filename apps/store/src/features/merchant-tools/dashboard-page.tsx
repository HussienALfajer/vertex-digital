'use client';

import { formatSyp, formatUsd, type MerchantDashboard } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { PercentIcon, TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { getDashboard } from './requests';
import { TierCard } from './tier-card';
import { useMerchantTier } from './tier-state';

type Period = MerchantDashboard['period'];

/**
 * "لوحة التاجر" (S21 F30, DB1–DB5): today or this month in Damascus: sales at the merchant's own
 * prices, net spending, the estimated profit with the orders left without a selling price, the
 * balance, the products sold most and the tier card (S23 ID3). Read live, never cached.
 */
export function DashboardPage() {
  const [period, setPeriod] = useState<Period>('today');
  const read = useCallback(() => getDashboard(period), [period]);
  const { state, reload, refreshing } = useMerchantRead(read);

  return (
    <div className="flex flex-col gap-6">
      <ToggleGroup<Period>
        aria-label={tm('dashboard.periodLabel')}
        value={[period]}
        onValueChange={(value) => value[0] && setPeriod(value[0])}
      >
        {(['today', 'month'] as const).map((value) => (
          <ToggleGroupItem key={value} value={value} className="h-11 px-4 text-md">
            {tm(`dashboard.periods.${value}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {state.status === 'ready' ? (
        // The other period's figures are dimmed until its own answer lands (A06-9).
        <div aria-busy={refreshing} className={refreshing ? 'opacity-60' : undefined}>
          <Dashboard data={state.data} />
        </div>
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={() => void reload()}
          skeleton={<MerchantSkeleton rows={4} />}
        />
      )}
    </div>
  );
}

function Dashboard({ data }: { data: MerchantDashboard }) {
  const loss = data.profitUsdUnits < 0;
  return (
    <div className="flex flex-col gap-6" data-testid="merchant-dashboard">
      {!data.sellingConfigured && (
        <Callout
          tone="info"
          icon={<PercentIcon />}
          title={tm('dashboard.emptyTitle')}
          description={tm('dashboard.emptyBody')}
          action={
            <Button size="xl" render={<Link href="/merchant/prices" prefetch={false} />}>
              {tm('dashboard.emptyAction')}
            </Button>
          }
        />
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label={tm('dashboard.sales')}
          hint={tm('dashboard.salesHint')}
          usd={data.salesUsdUnits}
          syp={data.salesSypUnits}
        />
        <Figure
          label={tm('dashboard.spending')}
          hint={tm('dashboard.spendingHint')}
          usd={data.spendingUsdUnits}
        />
        <Figure
          label={loss ? tm('dashboard.loss') : tm('dashboard.profit')}
          hint={tm('dashboard.profitHint')}
          usd={data.profitUsdUnits}
          tone={loss ? 'danger' : 'default'}
        />
        <Figure label={tm('dashboard.balance')} usd={data.balanceUsdUnits}>
          <Button
            variant="outline"
            size="xl"
            className="self-start"
            render={<Link href="/wallet" prefetch={false} />}
          >
            {tm('dashboard.topUp')}
          </Button>
        </Figure>
      </div>
      {data.ordersWithoutSale > 0 && (
        <p className="text-muted-foreground">
          {tm('dashboard.withoutSale', { count: data.ordersWithoutSale })}{' '}
          <Link href="/merchant/prices" prefetch={false} className="text-primary underline">
            {tm('dashboard.setPrices')}
          </Link>
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUpIcon className="size-5" aria-hidden="true" />
              {tm('dashboard.top')}
            </CardTitle>
          </CardHeader>
          {data.topProducts.length === 0 ? (
            <CardDescription>{tm('dashboard.topEmpty')}</CardDescription>
          ) : (
            <ol className="flex flex-col divide-y divide-border">
              {data.topProducts.map((product) => (
                <li
                  key={product.productId}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{product.nameAr}</span>
                    <span className="text-sm text-muted-foreground">{product.gameNameAr}</span>
                  </span>
                  <span className="flex flex-col items-end text-sm tabular-nums">
                    <span>{tm('dashboard.units', { count: product.units })}</span>
                    <bdi dir="ltr" className="text-muted-foreground">
                      {formatUsd(product.salesUsdUnits)}
                    </bdi>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <DashboardTier />
      </div>
    </div>
  );
}

function Figure({
  label,
  hint,
  usd,
  syp,
  tone = 'default',
  children,
}: {
  label: string;
  hint?: string;
  usd: number;
  syp?: number | null;
  tone?: 'default' | 'danger';
  children?: React.ReactNode;
}) {
  return (
    <Card className="gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <bdi
        dir="ltr"
        className={`text-end text-2xl font-semibold tabular-nums ${tone === 'danger' ? 'text-destructive' : ''}`}
      >
        {formatUsd(usd)}
      </bdi>
      {syp != null && (
        <span className="text-sm text-muted-foreground tabular-nums">
          {tm('common.approx', { amount: tm('common.syp', { amount: formatSyp(syp) }) })}
        </span>
      )}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {children}
    </Card>
  );
}

/** S23 ID3: the tier card in place of S21's level card, from the area's tier read. */
function DashboardTier() {
  const { tier, failed } = useMerchantTier();
  if (failed) return null;
  if (!tier) return <Skeleton className="h-64 w-full rounded-xl" aria-hidden="true" />;
  return <TierCard tier={tier} />;
}
