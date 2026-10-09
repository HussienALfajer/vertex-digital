import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type SupplierSummary, supplierHasCatalog } from '@vertex-digital/contracts';
import { Button, Card, CardTitle, PageHeader, Skeleton } from '@vertex-digital/ui';
import { RefreshCwIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { BalanceLine, LastRun, SupplierChips } from './supplier-parts';
import { suppliersQuery, useRequestSync } from './suppliers.queries';

/**
 * "/suppliers" (S07 screens): a card per supplier with its state, balance, last sync and counts,
 * and "مزامنة الآن". The API leaves out `fake` where it is not enabled.
 */
export function SuppliersPage() {
  const { t } = useTranslation();
  const suppliers = useQuery(suppliersQuery);
  return (
    <>
      <PageHeader
        title={t('suppliers.title')}
        description={t('suppliers.subtitle')}
        actions={
          <Button variant="outline" render={<Link to="/suppliers/policy" />}>
            <SlidersHorizontalIcon />
            {t('suppliers.policy.link')}
          </Button>
        }
      />
      {suppliers.isPending && (
        <div className="grid gap-6 lg:grid-cols-2" aria-hidden="true">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-56 w-full" />
          ))}
        </div>
      )}
      {suppliers.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, suppliers.error)}</FormAlert>
          <Button variant="outline" onClick={() => suppliers.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {suppliers.isSuccess && (
        <div className="grid gap-6 lg:grid-cols-2">
          {suppliers.data.map((supplier) => (
            <SupplierCard key={supplier.code} supplier={supplier} />
          ))}
        </div>
      )}
    </>
  );
}

function SupplierCard({ supplier }: { supplier: SupplierSummary }) {
  const { t } = useTranslation();
  const sync = useRequestSync();
  const [failure, setFailure] = useState<string | null>(null);
  const catalog = supplierHasCatalog(supplier.code);

  async function requestSync() {
    setFailure(null);
    try {
      await sync.mutateAsync(supplier.code);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <CardTitle>
            <bdi>{supplier.nameAr}</bdi>
          </CardTitle>
          <SupplierChips supplier={supplier} />
        </div>
        <Button
          variant="outline"
          render={<Link to="/suppliers/$code" params={{ code: supplier.code }} />}
        >
          {t('suppliers.open')}
        </Button>
      </div>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {supplier.code !== 'manual' && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t('suppliers.balance.title')}</dt>
            <dd>
              <BalanceLine supplier={supplier} />
            </dd>
          </div>
        )}
        {catalog && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t('suppliers.runs.last')}</dt>
            <dd>
              <LastRun run={supplier.lastRun} />
            </dd>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('suppliers.counts.offers')}</dt>
          <dd className="text-lg font-bold tabular-nums">{supplier.offerCount}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('suppliers.counts.mapped')}</dt>
          <dd className="text-lg font-bold tabular-nums">{supplier.mappedCount}</dd>
        </div>
      </dl>
      {failure && <FormAlert>{failure}</FormAlert>}
      {catalog && (
        <Button
          variant="outline"
          className="self-start"
          disabled={sync.isPending || supplier.lastRun?.status === 'running'}
          onClick={requestSync}
        >
          <RefreshCwIcon />
          {sync.isPending ? t('suppliers.sync.requesting') : t('suppliers.sync.now')}
        </Button>
      )}
    </Card>
  );
}
