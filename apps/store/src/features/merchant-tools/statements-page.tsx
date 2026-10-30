'use client';

import {
  formatSignedUsd,
  formatUsd,
  type Statement,
  type StatementEntry,
  type StatementMonths,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Input } from '@vertex-digital/ui/components/input';
import { Meter } from '@vertex-digital/ui/components/meter';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CalendarX2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileSpreadsheetIcon,
  PrinterIcon,
  ReceiptTextIcon,
  SearchIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useCallback, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure, Result } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { saveBlob } from './download';
import { tm, tmc } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { exportStatement, getStatement, getStatements } from './requests';
import { monthLabel } from './statement-document';
import {
  type MovementFilter,
  matchesMovement,
  movementChips,
  movementDays,
  movementFilterOf,
  movementTitle,
  statementFlow,
} from './statement-view';

const usd = (units: number) => ltr(formatUsd(units));

/** "30 تشرين الأول 2026": a Damascus day with its month's name (brand/identity.md §10). */
const dayFormat = new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dayLabel = (day: string) => dayFormat.format(new Date(`${day}T12:00:00Z`));

const timeFormat = new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
  timeZone: 'Asia/Damascus',
  hour: 'numeric',
  minute: '2-digit',
});

type Read = { months: StatementMonths['items']; statement: Statement | null };

/** "كشف الحساب" (S21 ST1): this month's statement, the others a step away. */
export function StatementsPage() {
  return <StatementScreen month={null} />;
}

/** A month's statement (S21 ST2), by the month in the address. */
export function StatementPage() {
  const { month } = useParams<{ month: string }>();
  return <StatementScreen month={month} />;
}

/**
 * The statement's screen (owner, 2026-10-30): the month moved in place (`‹ تشرين الأول 2026 ›`),
 * the month in one sentence and four figures (opening → in → out → closing), "مبيعاتك وربحك",
 * the tier's progress, and the movements: chips by kind, a search by order number or player id,
 * days newest first, each with its direction, a clear title, the link to its order and the balance
 * after it. The official statement stays the print page and the Excel, unchanged (ST2, ST3). A
 * month outside the account answers `STATEMENT_MONTH_INVALID`.
 */
function StatementScreen({ month }: { month: string | null }) {
  const read = useCallback(async (): Promise<Result<Read>> => {
    const months = await getStatements();
    if (!months.ok) return months;
    const shown = month ?? months.data.items[0]?.month;
    if (!shown) return { ok: true, data: { months: months.data.items, statement: null } };
    const result = await getStatement(shown);
    // A month outside the account is a page of its own, not a failed read.
    if (!result.ok && result.reason === 'STATEMENT_MONTH_INVALID') {
      return { ok: true, data: { months: months.data.items, statement: null } };
    }
    if (!result.ok) return result;
    return { ok: true, data: { months: months.data.items, statement: result.data } };
  }, [month]);
  const { state, reload } = useMerchantRead(read);
  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus
        state={state}
        onRetry={() => void reload()}
        skeleton={<MerchantSkeleton rows={4} />}
      />
    );
  }
  const { months, statement } = state.data;
  if (statement === null) return <InvalidMonth />;
  return <StatementView statement={statement} months={months} />;
}

function MonthNav({ month, months }: { month: string; months: StatementMonths['items'] }) {
  // Newest first: the next month is the one before in the list.
  const index = months.findIndex((item) => item.month === month);
  const older = index >= 0 ? months[index + 1]?.month : undefined;
  const newer = index > 0 ? months[index - 1]?.month : undefined;
  const step = (target: string | undefined, label: string, icon: ReactNode) =>
    target ? (
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        render={<Link href={`/merchant/statements/${target}`} prefetch={false} />}
      >
        {icon}
      </Button>
    ) : (
      <Button variant="ghost" size="icon" aria-label={label} disabled>
        {icon}
      </Button>
    );
  return (
    <nav aria-label={tm('statements.months')} className="flex items-center gap-1">
      {step(
        older,
        tm('statements.screen.monthPrev'),
        <ChevronRightIcon className="ltr:rotate-180" aria-hidden="true" />,
      )}
      <h2 className="min-w-36 text-center text-lg font-bold" aria-live="polite">
        {monthLabel(month)}
      </h2>
      {step(
        newer,
        tm('statements.screen.monthNext'),
        <ChevronLeftIcon className="ltr:rotate-180" aria-hidden="true" />,
      )}
    </nav>
  );
}

function StatementView({
  statement,
  months,
}: {
  statement: Statement;
  months: StatementMonths['items'];
}) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const flow = statementFlow(statement);

  async function download() {
    setFailure(null);
    setBusy(true);
    const result = await exportStatement(statement.month);
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    saveBlob(result.blob, result.fileName);
  }

  const figures = [
    { key: 'opening', units: flow.openingUnits },
    { key: 'in', units: flow.inUnits },
    { key: 'out', units: flow.outUnits },
    { key: statement.current ? 'closingNow' : 'closing', units: flow.closingUnits },
  ] as const;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MonthNav month={statement.month} months={months} />
          {statement.current && <Badge tone="outline">{tm('statements.current')}</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="xl"
            render={
              <Link href={`/merchant/statements/${statement.month}/print`} prefetch={false} />
            }
          >
            <PrinterIcon aria-hidden="true" />
            {tm('statements.print')}
          </Button>
          <Button variant="outline" size="xl" disabled={busy} onClick={() => void download()}>
            <FileSpreadsheetIcon aria-hidden="true" />
            {tm('statements.excel')}
          </Button>
        </div>
      </div>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}

      <p className="text-md" data-testid="statement-summary">
        {tm(
          statement.current ? 'statements.screen.summaryCurrent' : 'statements.screen.summaryPast',
          {
            opening: usd(flow.openingUnits),
            in: usd(flow.inUnits),
            out: usd(flow.outUnits),
            closing: usd(flow.closingUnits),
          },
        )}
      </p>

      <ol
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        aria-label={tm('statements.screen.movements')}
      >
        {figures.map((figure, index) => (
          <li key={figure.key} className="relative">
            <Card className="h-full gap-1 p-4">
              <span className="text-xs text-muted-foreground">
                {tm(`statements.screen.flow.${figure.key}`)}
              </span>
              <bdi
                dir="ltr"
                className={`text-end text-xl font-bold tabular-nums ${
                  figure.key === 'in' && figure.units > 0 ? 'text-status-success-foreground' : ''
                }`}
              >
                {figure.key === 'in' && figure.units > 0 ? '+' : ''}
                {figure.key === 'out' && figure.units > 0 ? '-' : ''}
                {formatUsd(figure.units)}
              </bdi>
            </Card>
            {index < figures.length - 1 && (
              <ChevronLeftIcon
                className="absolute top-1/2 -end-3 z-10 hidden size-4 -translate-y-1/2 text-muted-foreground lg:block ltr:rotate-180"
                aria-hidden="true"
              />
            )}
          </li>
        ))}
      </ol>

      <div className="grid gap-4 lg:grid-cols-2">
        <SalesCard statement={statement} />
        {statement.tier && <TierCard tier={statement.tier} />}
      </div>

      <Movements entries={statement.entries} />
    </div>
  );
}

/** "مبيعاتك وربحك": the month's priced deliveries, an estimate, with the unpriced ones counted. */
function SalesCard({ statement }: { statement: Statement }) {
  const { sales } = statement;
  const rows = [
    { key: 'sales', units: sales.salesUsdUnits },
    { key: 'cost', units: sales.costUsdUnits },
  ] as const;
  return (
    <Card className="gap-3 p-4" data-testid="statement-sales">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold">{tm('statements.screen.sales.title')}</h3>
        <Badge tone="neutral">{tm('statements.screen.sales.estimate')}</Badge>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">
              {tm(`statements.screen.sales.${row.key}`)}
            </dt>
            <dd>
              <bdi dir="ltr" className="font-semibold tabular-nums">
                {formatUsd(row.units)}
              </bdi>
            </dd>
          </div>
        ))}
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{tm('statements.screen.sales.profit')}</dt>
          <dd>
            <bdi
              dir="ltr"
              className={`font-bold tabular-nums ${
                sales.profitUsdUnits > 0
                  ? 'text-status-success-foreground'
                  : sales.profitUsdUnits < 0
                    ? 'text-status-danger-foreground'
                    : ''
              }`}
            >
              {formatSignedUsd(sales.profitUsdUnits)}
            </bdi>
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">{tm('statements.screen.sales.note')}</p>
      {sales.ordersWithoutSale > 0 && (
        <p className="text-xs text-status-warning-foreground">
          {tmc('statements.screen.sales.without', sales.ordersWithoutSale)}{' '}
          <Link href="/merchant/prices" prefetch={false} className="font-medium underline">
            {tm('statements.screen.sales.setPrices')}
          </Link>
        </p>
      )}
    </Card>
  );
}

/** S23 ID9: the month's net purchases toward the next tier, "الباقي للفضي $295.20". */
function TierCard({ tier }: { tier: NonNullable<Statement['tier']> }) {
  const net = Math.max(tier.netPurchasesUsdUnits, 0);
  return (
    <Card className="gap-3 p-4" data-testid="statement-tier">
      <h3 className="font-bold">{tm('statements.screen.tier.title')}</h3>
      <p className="text-sm text-muted-foreground">
        {tm('statements.screen.tier.net', { amount: usd(tier.netPurchasesUsdUnits) })}
      </p>
      {tier.next ? (
        <>
          <Meter
            aria-label={tm('statements.screen.tier.meter')}
            value={net}
            max={net + tier.next.missingUsdUnits}
          />
          <p className="text-sm font-medium">
            {tm('statements.screen.tier.next', {
              name: tm(`tier.names.${tier.next.tier}`),
              amount: usd(tier.next.missingUsdUnits),
            })}
          </p>
        </>
      ) : (
        <p className="text-sm font-medium">{tm('statements.screen.tier.top')}</p>
      )}
    </Card>
  );
}

function titleOf(entry: StatementEntry): string {
  const title = movementTitle(entry);
  switch (title.key) {
    case 'deposit':
      return title.method
        ? tm('statements.screen.titles.depositVia', {
            method: tm(`statements.methods.${title.method}`),
          })
        : tm('statements.screen.titles.deposit');
    case 'purchase':
      return title.productNameAr
        ? tm('statements.screen.titles.purchaseOf', { product: title.productNameAr })
        : tm('statements.screen.titles.purchase');
    case 'checkout':
      return tmc('statements.screen.titles.checkout', title.count);
    case 'refund':
      return tm('statements.screen.titles.refund');
    case 'adjustment':
      if (title.reversal) return tm('statements.screen.titles.reversal');
      if (title.category === 'correction') {
        return tm(
          title.credit
            ? 'statements.screen.titles.correctionIn'
            : 'statements.screen.titles.correctionOut',
        );
      }
      return tm(`statements.screen.titles.${title.category}`);
    default:
      return tm('statements.screen.titles.other');
  }
}

function Movements({ entries }: { entries: StatementEntry[] }) {
  const [filter, setFilter] = useState<MovementFilter>('all');
  const [query, setQuery] = useState('');
  const chips = movementChips(entries);
  const shown = entries.filter(
    (entry) =>
      (filter === 'all' || movementFilterOf(entry) === filter) && matchesMovement(entry, query),
  );
  const days = movementDays(shown);
  return (
    <section aria-labelledby="statement-movements" className="flex flex-col gap-3">
      <h3 id="statement-movements" className="text-lg font-bold">
        {tm('statements.screen.movements')}
      </h3>
      {entries.length === 0 ? (
        <EmptyState icon={<ReceiptTextIcon />} title={tm('statements.entriesEmpty')} />
      ) : (
        <>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="-mx-1 min-w-0 overflow-x-auto px-1 pb-1 md:flex-1">
              <ToggleGroup<MovementFilter>
                aria-label={tm('statements.screen.chips.label')}
                value={[filter]}
                onValueChange={(value) => setFilter(value[0] ?? 'all')}
              >
                {chips.map((chip) => (
                  <ToggleGroupItem
                    key={chip.filter}
                    value={chip.filter}
                    className="h-11 shrink-0 gap-1.5 px-3"
                  >
                    {tm(`statements.screen.chips.${chip.filter}`)}
                    <span className="text-xs text-muted-foreground tabular-nums">{chip.count}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="relative md:w-72">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                autoComplete="off"
                className="h-11 ps-9 text-md"
                aria-label={tm('statements.screen.search')}
                placeholder={tm('statements.screen.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          {days.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {tm('statements.screen.noMatch')}
            </p>
          ) : (
            <div className="flex flex-col gap-4" data-testid="statement-movements">
              {days.map((day) => (
                <section key={day.day} className="flex flex-col gap-1">
                  <h4 className="text-sm font-bold text-muted-foreground">{dayLabel(day.day)}</h4>
                  <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                    {day.entries.map((entry) => (
                      <Movement
                        // Entries hold no id: their time and the balance after them name them.
                        key={`${entry.occurredAt}:${entry.balanceAfterUnits}:${entry.amountUnits}`}
                        entry={entry}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Movement({ entry }: { entry: StatementEntry }) {
  const incoming = entry.amountUnits > 0;
  const link = entry.order
    ? {
        href: `/orders/${entry.order.id}`,
        label: tm('statements.screen.order', { number: entry.order.number }),
      }
    : entry.checkout
      ? {
          href: `/orders?checkout=${entry.checkout.id}`,
          label: tm('statements.screen.checkoutOrders'),
        }
      : null;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <span
        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
          incoming
            ? 'bg-status-success text-status-success-foreground'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {incoming ? (
          <ArrowDownLeftIcon className="size-4" aria-label={tm('statements.screen.in')} />
        ) : (
          <ArrowUpRightIcon className="size-4" aria-label={tm('statements.screen.out')} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium break-words">
          <bdi>{titleOf(entry)}</bdi>
        </span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{timeFormat.format(new Date(entry.occurredAt))}</span>
          {entry.order?.fields[0] && (
            <bdi dir="ltr" className="tabular-nums">
              {entry.order.fields[0].value}
            </bdi>
          )}
          {entry.adjustment?.customerNote && <span>{entry.adjustment.customerNote}</span>}
        </span>
        {link && (
          <Link
            href={link.href}
            prefetch={false}
            className="inline-flex min-h-8 items-center self-start text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {link.label}
          </Link>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <bdi
          dir="ltr"
          className={`text-sm font-bold tabular-nums ${incoming ? 'text-status-success-foreground' : ''}`}
        >
          {formatSignedUsd(entry.amountUnits)}
        </bdi>
        <span className="text-xs text-muted-foreground tabular-nums">
          {tm('statements.screen.balance', { amount: usd(entry.balanceAfterUnits) })}
        </span>
      </span>
    </li>
  );
}

/** A month outside the account (`STATEMENT_MONTH_INVALID`), the month page and its print. */
export function InvalidMonth() {
  return (
    <EmptyState
      icon={<CalendarX2Icon />}
      title={tm('statements.invalid')}
      action={
        <Button
          variant="outline"
          size="xl"
          render={<Link href="/merchant/statements" prefetch={false} />}
        >
          {tm('statements.back')}
        </Button>
      }
    />
  );
}
