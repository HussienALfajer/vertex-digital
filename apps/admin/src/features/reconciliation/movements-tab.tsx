import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  formatRate,
  TREASURY_PLACES,
  type TreasuryMovement,
  type TreasuryPlace,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { ArrowLeftRightIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/format';
import { movementsQuery } from './reconciliation.queries';
import { money, placeLabel } from './reconciliation-labels';
import { LoadError, OverviewSkeleton } from './reconciliation-states';
import { ReverseMovementDialog } from './reverse-movement-dialog';

const ALL = 'all';

/**
 * "الحركات": every treasury movement, newest first, filtered by place; "عكس" on a movement that
 * is not a reversal and was not reversed (rule T9).
 */
export function MovementsTab({
  place,
  onPlace,
}: {
  place: TreasuryPlace | undefined;
  onPlace: (place: TreasuryPlace | undefined) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(movementsQuery(place));
  const [reversing, setReversing] = useState<TreasuryMovement | null>(null);
  const movements = list.data?.pages.flatMap((page) => page.items) ?? [];
  const items = [
    { value: ALL, label: t('reconciliation.movements.allPlaces') },
    ...TREASURY_PLACES.map((item) => ({ value: item, label: placeLabel(t, item) })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <Field className="max-w-xs">
        <FieldLabel>{t('reconciliation.movements.place')}</FieldLabel>
        <Select
          items={items}
          value={place ?? ALL}
          onValueChange={(value) =>
            onPlace(!value || value === ALL ? undefined : (value as TreasuryPlace))
          }
        >
          <SelectTrigger aria-label={t('reconciliation.movements.place')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {list.isPending && <OverviewSkeleton />}
      {list.isError && <LoadError error={list.error} onRetry={() => list.refetch()} />}
      {list.isSuccess && movements.length === 0 && (
        <EmptyState
          icon={<ArrowLeftRightIcon />}
          title={t('reconciliation.movements.emptyTitle')}
          description={t('reconciliation.movements.emptyBody')}
        />
      )}
      {movements.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('reconciliation.movements.date')}</TableHead>
              <TableHead>{t('reconciliation.movements.fromTo')}</TableHead>
              <TableHead>{t('reconciliation.movements.sent')}</TableHead>
              <TableHead>{t('reconciliation.movements.received')}</TableHead>
              <TableHead>{t('reconciliation.movements.feeOrRate')}</TableHead>
              {/* Column names of their own, not the dialog's labels (audit A09-39). */}
              <TableHead>{t('reconciliation.movements.category')}</TableHead>
              <TableHead>{t('reconciliation.movements.reference')}</TableHead>
              <TableHead>{t('reconciliation.movements.reason')}</TableHead>
              <TableHead>{t('reconciliation.movements.admin')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('reconciliation.places.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {movements.map((movement) => (
              <MovementRow
                key={movement.id}
                movement={movement}
                onReverse={() => setReversing(movement)}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
        </Button>
      )}
      <Dialog open={reversing !== null} onOpenChange={(open) => !open && setReversing(null)}>
        {reversing && (
          <ReverseMovementDialog movement={reversing} onDone={() => setReversing(null)} />
        )}
      </Dialog>
    </div>
  );
}

function MovementRow({
  movement,
  onReverse,
}: {
  movement: TreasuryMovement;
  onReverse: () => void;
}) {
  const { t } = useTranslation();
  const reversible = movement.reversesMovementId === null && movement.reversedByMovementId === null;
  return (
    <TableRow>
      <TableCell>{formatDateTime(movement.createdAt)}</TableCell>
      <TableCell>
        <span className="flex flex-col gap-1">
          <span>
            {t('reconciliation.movements.route', {
              from: placeLabel(t, movement.from),
              to: placeLabel(t, movement.to),
            })}
          </span>
          <span className="flex flex-wrap gap-1">
            {movement.kind === 'supplier_correction' && (
              <Badge tone="info">{t('reconciliation.movements.correction')}</Badge>
            )}
            {movement.openingBalance && (
              <Badge tone="brand">{t('reconciliation.movements.opening')}</Badge>
            )}
            {movement.reversesMovementId && (
              <Badge tone="neutral">{t('reconciliation.movements.reversal')}</Badge>
            )}
            {movement.reversedByMovementId && (
              <Badge tone="warning">{t('reconciliation.movements.reversed')}</Badge>
            )}
          </span>
        </span>
      </TableCell>
      <TableCell className="tabular-nums">
        {money(t, movement.sentCurrency, movement.sentUnits)}
      </TableCell>
      <TableCell className="tabular-nums">
        {money(t, movement.receivedCurrency, movement.receivedUnits)}
      </TableCell>
      <TableCell className="tabular-nums">
        {movement.feeUnits !== null && movement.feeUnits > 0
          ? money(t, movement.sentCurrency, movement.feeUnits)
          : movement.rate
            ? formatRate(movement.rate)
            : '—'}
      </TableCell>
      <TableCell>
        {movement.outsideCategory
          ? t(`reconciliation.categories.${movement.outsideCategory}`)
          : '—'}
      </TableCell>
      <TableCell>
        {movement.order ? (
          <Link
            to="/orders/$id"
            params={{ id: movement.order.id }}
            className="underline-offset-4 hover:underline"
          >
            <bdi dir="ltr">{movement.order.number}</bdi>
          </Link>
        ) : movement.externalReference ? (
          <bdi dir="ltr">{movement.externalReference}</bdi>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell className="max-w-64 whitespace-normal">{movement.reason}</TableCell>
      <TableCell>{movement.adminName ?? '—'}</TableCell>
      <TableCell>
        {reversible && (
          <Button variant="outline" size="sm" onClick={onReverse}>
            {t('reconciliation.reverse.open')}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
