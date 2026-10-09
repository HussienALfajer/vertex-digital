import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type SupplierCode, supplierHasCatalog } from '@vertex-digital/contracts';
import {
  Button,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import { ArrowRightIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ConnectionTab } from './connection-tab';
import { HealthTab } from './health-tab';
import { OffersTab } from './offers-tab';
import { RunsTab } from './runs-tab';
import { SupplierChips } from './supplier-parts';
import { offerFilters, SUPPLIER_TABS, type SupplierSearch } from './supplier-search';
import { supplierQuery } from './suppliers.queries';

/**
 * "/suppliers/$code" (S07 screens): the connection, the offers, the sync runs and the health in
 * tabs, the tab and the offers' filters in the URL. `manual` has no sync: its offers are the
 * manual routes' (rule RT7).
 */
export function SupplierPage({
  code,
  search,
  onSearch,
}: {
  code: SupplierCode;
  search: SupplierSearch;
  onSearch: (next: SupplierSearch) => void;
}) {
  const { t } = useTranslation();
  const supplier = useQuery(supplierQuery(code));
  const tabs = SUPPLIER_TABS.filter((tab) => tab !== 'runs' || supplierHasCatalog(code));
  const tab = search.tab && tabs.includes(search.tab) ? search.tab : 'connection';

  if (supplier.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (supplier.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, supplier.error)}</FormAlert>
        <Button variant="outline" onClick={() => supplier.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const data = supplier.data;
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi>{data.nameAr}</bdi>
            <SupplierChips supplier={data} />
          </span>
        }
        description={t(`suppliers.descriptions.${code}`)}
        actions={
          <Button variant="ghost" render={<Link to="/suppliers" />}>
            <ArrowRightIcon className="ltr:-scale-x-100" />
            {t('suppliers.back')}
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          onSearch(value === 'connection' ? {} : { tab: value as SupplierSearch['tab'] })
        }
      >
        <TabsList>
          {tabs.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`suppliers.tabs.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="connection">
          <ConnectionTab supplier={data} />
        </TabsContent>
        <TabsContent value="offers">
          <OffersTab
            supplier={data}
            search={offerFilters(search)}
            onSearch={(next) => onSearch({ ...next, tab: 'offers' })}
          />
        </TabsContent>
        {tabs.includes('runs') && (
          <TabsContent value="runs">
            <RunsTab code={code} />
          </TabsContent>
        )}
        <TabsContent value="health">
          <HealthTab supplier={data} />
        </TabsContent>
      </Tabs>
    </>
  );
}
