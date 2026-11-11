'use client';

import { formatUsd, type ShopStats } from '@vertex-digital/contracts';
import { Card } from '@vertex-digital/ui/components/card';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { useCallback, useState } from 'react';
import {
  MerchantPageStatus,
  MerchantSkeleton,
  useMerchantRead,
} from '@/features/merchant-tools/merchant-state';
import { formatDate } from '@/lib/format';
import { type ShopAreaMessageKey, tsa } from './i18n';
import { getShopStats } from './requests';
import { barShares } from './rules';

type Period = ShopStats['period'];
type Figure = keyof ShopStats['totals'];

const FIGURES: readonly { key: Figure; label: ShopAreaMessageKey; money: boolean }[] = [
  { key: 'visits', label: 'stats.visits', money: false },
  { key: 'signUps', label: 'stats.signUps', money: false },
  { key: 'activeCustomers', label: 'stats.activeCustomers', money: false },
  { key: 'orders', label: 'stats.orders', money: false },
  { key: 'salesUsdUnits', label: 'stats.sales', money: true },
  { key: 'marginReleasedUsdUnits', label: 'stats.margin', money: true },
  { key: 'transfersUsdUnits', label: 'stats.transfers', money: true },
  { key: 'returnsUsdUnits', label: 'stats.returns', money: true },
];

/** The figures a day carries (active customers are counted over the period only). */
const DAILY: readonly Exclude<Figure, 'activeCustomers'>[] = [
  'visits',
  'orders',
  'salesUsdUnits',
  'marginReleasedUsdUnits',
];

/**
 * "الإحصاءات" (S26 SP3): today, this month or the last 30 Damascus days: visits, sign-ups,
 * customers who bought, orders, sales, the margin released, transfers and returns, with a bar per
 * day for the figure chosen.
 */
export function ShopStatsPage() {
  const [period, setPeriod] = useState<Period>('last_30_days');
  const read = useCallback(() => getShopStats(period), [period]);
  const { state, reload, refreshing } = useMerchantRead(read);
  return (
    <div className="flex flex-col gap-4">
      <ToggleGroup<Period>
        aria-label={tsa('stats.period')}
        value={[period]}
        onValueChange={(value) => value[0] && setPeriod(value[0])}
      >
        {(['today', 'month', 'last_30_days'] as const).map((value) => (
          <ToggleGroupItem key={value} value={value} className="h-11 px-4 text-md">
            {tsa(`stats.periods.${value}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {state.status === 'ready' ? (
        <div aria-busy={refreshing} className={refreshing ? 'opacity-60' : undefined}>
          <Stats stats={state.data} />
        </div>
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={reload}
          skeleton={<MerchantSkeleton rows={2} />}
        />
      )}
    </div>
  );
}

const shown = (value: number, money: boolean) => (money ? formatUsd(value) : String(value));

function Stats({ stats }: { stats: ShopStats }) {
  const [figure, setFigure] = useState<(typeof DAILY)[number]>('orders');
  const money = FIGURES.find((item) => item.key === figure)?.money ?? false;
  const shares = barShares(stats.days.map((day) => day[figure]));
  const label = FIGURES.find((item) => item.key === figure)?.label ?? 'stats.orders';
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {tsa('stats.range', { from: formatDate(stats.from), to: formatDate(stats.to) })}
      </p>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="shop-stats">
        {FIGURES.map((item) => (
          <li key={item.key}>
            <Card className="gap-1">
              <span className="text-sm text-muted-foreground">{tsa(item.label)}</span>
              <bdi dir="ltr" className="text-end text-xl font-bold tabular-nums">
                {shown(stats.totals[item.key], item.money)}
              </bdi>
            </Card>
          </li>
        ))}
      </ul>
      {stats.days.length > 1 && (
        <Card className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">{tsa('stats.daily')}</h2>
            <ToggleGroup<(typeof DAILY)[number]>
              aria-label={tsa('stats.daily')}
              value={[figure]}
              onValueChange={(value) => value[0] && setFigure(value[0])}
              className="flex-wrap"
            >
              {DAILY.map((key) => (
                <ToggleGroupItem key={key} value={key} className="h-11 px-3 text-sm">
                  {tsa(FIGURES.find((item) => item.key === key)?.label ?? 'stats.orders')}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <ol
            className="flex h-32 items-end gap-0.5"
            aria-label={tsa('stats.chart', { figure: tsa(label) })}
          >
            {stats.days.map((day, index) => (
              <li
                key={day.date}
                className="flex h-full min-w-0 flex-1 items-end"
                title={`${formatDate(day.date)}: ${shown(day[figure], money)}`}
              >
                <span className="sr-only">
                  {formatDate(day.date)}: {shown(day[figure], money)}
                </span>
                <span
                  aria-hidden="true"
                  className="block w-full rounded-t-sm bg-primary"
                  style={{ height: `${Math.max(2, Math.round((shares[index] ?? 0) * 100))}%` }}
                />
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}
