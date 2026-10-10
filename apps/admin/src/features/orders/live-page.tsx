import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  formatUsd,
  LIVE_COLUMNS,
  type LiveBoard,
  type LiveColumn,
  type LiveOrderCard,
  SUPPLIER_CODES,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  cn,
  EmptyState,
  PageHeader,
  Skeleton,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import { CircleAlertIcon, InboxIcon, RadioIcon, WifiOffIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useAdminStream,
  useDebounced,
  useStreamState,
  useVisibleAgain,
} from '../../lib/admin-stream';
import { errorMessage } from '../../lib/errors';
import { formatDuration } from '../../lib/format';
import { allGamesQuery } from '../catalog/catalog.queries';
import { ALL, FilterSelect } from './filter-select';
import { type LiveSearch, liveQuery } from './live-search';
import { LiveSheet } from './live-sheet';
import { playChime, useLiveSound } from './live-sound';
import {
  elapsedMs,
  finishedInMs,
  formatElapsed,
  hasNewWaiting,
  isSlow,
  waitingIds,
} from './live-time';
import { STATUS_TONES } from './order-labels';
import type { OrderSearch } from './order-search';
import { liveBoardQuery } from './orders.queries';

/** Rule LR5: the board drops orders finished over an hour ago on its own every minute. */
const REFRESH_MS = 60_000;
/** Rule LR5: a burst of stream events is one read, a second after the first. */
const EVENT_DEBOUNCE_MS = 1_000;

/** "+N أخرى" opens the matching tab of the orders list (rule LR1). */
const LIST_TABS: Record<LiveColumn, OrderSearch['tab']> = {
  at_supplier: 'active',
  manual: 'manual',
  review: 'review',
  finished: undefined,
};

/**
 * The live room (S11, F17): the four columns of open and just-finished orders, read again on
 * every stream event, on reconnect, when the tab comes back and every minute (LR5); slow orders
 * amber and held ones red (LR3); the sound and the tab title for what waits on the admin (LR6);
 * a side sheet with each order's actions (LR7). Below tablet width the columns become tabs.
 */
export function LivePage({
  search,
  onSearch,
}: {
  search: LiveSearch;
  onSearch: (search: LiveSearch) => void;
}) {
  const { t } = useTranslation();
  const board = useQuery({ ...liveBoardQuery(liveQuery(search)), refetchInterval: REFRESH_MS });
  const refetch = useDebounced(() => void board.refetch(), EVENT_DEBOUNCE_MS);
  useAdminStream(refetch);
  useVisibleAgain(refetch);
  const [sound, setSound] = useLiveSound();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<LiveColumn>('review');
  const now = useNow();
  const waiting = board.data
    ? board.data.columns.review.count + board.data.columns.manual.count
    : 0;

  useTabTitle(waiting);
  useChime(board.data, sound);

  return (
    <>
      <PageHeader
        title={t('orders.live.title')}
        description={t('orders.live.subtitle')}
        actions={<StreamIndicator />}
      />
      <LiveFilters
        search={search}
        onSearch={onSearch}
        sound={sound}
        onSound={setSound}
        awaitingBalance={board.data?.awaitingBalance ?? 0}
      />
      {board.isPending && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
          {LIVE_COLUMNS.map((column) => (
            <Skeleton key={column} className="h-96 w-full" />
          ))}
        </div>
      )}
      {board.isError && !board.data && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, board.error)}
          action={
            <Button variant="outline" onClick={() => board.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {board.data && (
        <>
          {LIVE_COLUMNS.every((column) => board.data.columns[column].count === 0) && (
            <EmptyState icon={<InboxIcon />} title={t('orders.live.emptyBoard')} />
          )}
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as LiveColumn)}
            className="md:hidden"
          >
            <TabsList className="w-full">
              {LIVE_COLUMNS.map((column) => (
                <TabsTrigger key={column} value={column} className="flex-1">
                  {t(`orders.live.columns.${column}`)} ({board.data.columns[column].count})
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
            {LIVE_COLUMNS.map((column) => (
              <Column
                key={column}
                column={column}
                content={board.data.columns[column]}
                hiddenOnPhone={column !== tab}
                now={now}
                onOpen={setSelected}
              />
            ))}
          </div>
        </>
      )}
      <LiveSheet orderId={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/** One clock for every card: they tick together, once a second. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Rule LR6: the tab's title starts with `(n)`, the orders waiting on the admin. */
function useTabTitle(waiting: number) {
  const base = useRef(document.title);
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${base.current}` : base.current;
  }, [waiting]);
  useEffect(() => {
    const original = base.current;
    return () => {
      document.title = original;
    };
  }, []);
}

/** Rule LR6: a chime when a read shows an order new to "review" or "manual", if the toggle is on. */
function useChime(board: LiveBoard | undefined, sound: boolean) {
  const previous = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!board) return;
    const next = waitingIds(board.columns);
    if (sound && hasNewWaiting(previous.current, next)) playChime();
    previous.current = next;
  }, [board, sound]);
}

function StreamIndicator() {
  const { t } = useTranslation();
  const state = useStreamState();
  return state === 'live' ? (
    <Badge tone="success" role="status">
      <RadioIcon />
      {t('orders.live.stream.live')}
    </Badge>
  ) : (
    <Badge tone="warning" role="status">
      <WifiOffIcon />
      {t('orders.live.stream.reconnecting')}
    </Badge>
  );
}

function LiveFilters({
  search,
  onSearch,
  sound,
  onSound,
  awaitingBalance,
}: {
  search: LiveSearch;
  onSearch: (search: LiveSearch) => void;
  sound: boolean;
  onSound: (on: boolean) => void;
  awaitingBalance: number;
}) {
  const { t } = useTranslation();
  const games = useQuery(allGamesQuery);
  const soundId = useId();
  return (
    <Card>
      <search className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect
          label={t('orders.filters.supplier')}
          value={search.supplier ?? ALL}
          onChange={(value) =>
            onSearch({
              ...search,
              supplier: value === ALL ? undefined : (value as LiveSearch['supplier']),
            })
          }
          options={SUPPLIER_CODES.map((code) => ({
            value: code,
            label: t(`orders.suppliers.${code}`),
          }))}
        />
        <FilterSelect
          label={t('orders.live.filters.game')}
          value={search.gameId ?? ALL}
          onChange={(value) => onSearch({ ...search, gameId: value === ALL ? undefined : value })}
          options={(games.data?.items ?? []).map((game) => ({
            value: game.id,
            label: game.nameAr,
          }))}
        />
        <FilterSelect
          label={t('orders.filters.test')}
          value={search.test ?? ALL}
          onChange={(value) =>
            onSearch({
              ...search,
              test: value === ALL ? undefined : (value as LiveSearch['test']),
            })
          }
          options={[
            { value: 'hide', label: t('orders.live.filters.hideTest') },
            { value: 'only', label: t('orders.live.filters.onlyTest') },
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
          <label
            htmlFor={soundId}
            className="flex cursor-pointer items-center gap-2 text-sm font-medium"
          >
            <Switch id={soundId} checked={sound} onCheckedChange={(on) => onSound(on)} />
            {t('orders.live.sound')}
          </label>
          {awaitingBalance > 0 && (
            <Link
              to="/orders"
              search={{ status: 'awaiting_balance' }}
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              {t('orders.live.awaitingBalance', { count: awaitingBalance })}
            </Link>
          )}
        </div>
      </search>
    </Card>
  );
}

function Column({
  column,
  content,
  hiddenOnPhone,
  now,
  onOpen,
}: {
  column: LiveColumn;
  content: LiveBoard['columns'][LiveColumn];
  hiddenOnPhone: boolean;
  now: number;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const more = content.count - content.cards.length;
  return (
    <section
      aria-labelledby={headingId}
      data-column={column}
      className={cn(
        'flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3',
        hiddenOnPhone ? 'hidden md:flex' : 'flex',
      )}
    >
      <h2 id={headingId} className="flex items-center justify-between gap-2 text-base font-bold">
        {t(`orders.live.columns.${column}`)}
        <Badge tone={column === 'review' && content.count > 0 ? 'danger' : 'neutral'}>
          {content.count}
        </Badge>
      </h2>
      {content.cards.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t('orders.live.emptyColumn')}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {content.cards.map((card) => (
          <li key={card.id}>
            <OrderCard card={card} column={column} now={now} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Link
          to="/orders"
          search={LIST_TABS[column] ? { tab: LIST_TABS[column] } : {}}
          className="text-center text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('orders.live.more', { count: more })}
        </Link>
      )}
    </section>
  );
}

function OrderCard({
  card,
  column,
  now,
  onOpen,
}: {
  card: LiveOrderCard;
  column: LiveColumn;
  now: number;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const slow = column === 'at_supplier' && isSlow(card, now);
  const finishedIn = column === 'finished' ? finishedInMs(card) : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(card.id)}
      data-slow={slow || undefined}
      data-review={column === 'review' || undefined}
      className={cn(
        'flex w-full flex-col gap-2 rounded-md border border-border bg-surface p-3 text-start',
        'transition-colors duration-150 ease-out hover:border-primary',
        'data-slow:border-status-warning-foreground data-review:border-destructive',
        'data-review:border-s-4 data-slow:border-s-4',
      )}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <bdi dir="ltr" className="font-bold">
          {card.number}
        </bdi>
        <span className="flex flex-wrap items-center gap-1">
          {card.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
          {slow && <Badge tone="warning">{t('orders.live.slow')}</Badge>}
          {column === 'finished' && (
            <Badge tone={STATUS_TONES[card.status]}>{t(`orders.statuses.${card.status}`)}</Badge>
          )}
        </span>
      </span>
      <span className="text-sm">
        {card.game.nameAr} · {card.product.nameAr}
      </span>
      <span className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          {t('orders.live.quantityTotal', { quantity: card.quantity })}{' '}
          <bdi dir="ltr" className="font-medium text-foreground tabular-nums">
            {formatUsd(card.totalUsdUnits)}
          </bdi>
        </span>
        {card.attempt && <span>{card.attempt.supplierNameAr}</span>}
      </span>
      <span className="flex items-center justify-between gap-2 text-sm">
        {finishedIn !== null ? (
          <span className="text-muted-foreground">
            {t('orders.live.finishedIn', { duration: formatDuration(finishedIn) })}
          </span>
        ) : (
          <span
            className={cn(
              'font-medium tabular-nums',
              slow && 'text-status-warning-foreground',
              column === 'review' && 'text-destructive-text',
            )}
          >
            <span className="sr-only">{t('orders.live.elapsed')} </span>
            <bdi dir="ltr">{formatElapsed(elapsedMs(card, now))}</bdi>
          </span>
        )}
      </span>
    </button>
  );
}
