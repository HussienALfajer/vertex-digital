import { useQuery } from '@tanstack/react-query';
import { formatUsd, type SupplierOffer } from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { HistoryIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { offerCostsQuery } from './suppliers.queries';

/** An offer's cost changes, newest first (`supplier_cost_changes`): by sync or by the admin. */
export function CostHistoryDialog({ offer }: { offer: SupplierOffer }) {
  const { t } = useTranslation();
  const costs = useQuery(offerCostsQuery(offer.id));
  const amount = (units: number | null) =>
    units === null ? '—' : <bdi dir="ltr">{formatUsd(units)}</bdi>;
  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('suppliers.costs.title')}</DialogTitle>
        <DialogDescription>
          <bdi>{offer.name}</bdi>
        </DialogDescription>
      </DialogHeader>
      {costs.isPending && <Skeleton className="h-40 w-full" aria-hidden="true" />}
      {costs.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, costs.error)}</FormAlert>
          <Button variant="outline" onClick={() => costs.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {costs.isSuccess &&
        (costs.data.items.length === 0 ? (
          <EmptyState icon={<HistoryIcon />} title={t('suppliers.costs.empty')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('suppliers.costs.time')}</TableHead>
                <TableHead>{t('suppliers.costs.from')}</TableHead>
                <TableHead>{t('suppliers.costs.to')}</TableHead>
                <TableHead>{t('suppliers.costs.by')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {costs.data.items.map((change) => (
                <TableRow key={change.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(change.createdAt)}
                  </TableCell>
                  <TableCell className="tabular-nums">{amount(change.fromUsdUnits)}</TableCell>
                  <TableCell className="font-medium tabular-nums">
                    {amount(change.toUsdUnits)}
                  </TableCell>
                  <TableCell>
                    {change.byAdmin ? t('suppliers.costs.admin') : t('suppliers.costs.sync')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </DialogContent>
  );
}
