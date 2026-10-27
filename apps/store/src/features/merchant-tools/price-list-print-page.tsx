'use client';

import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { DocumentPrintFrame } from './document-print-frame';
import { tm } from './i18n';
import { MerchantPageStatus, useMerchantRead } from './merchant-state';
import { PriceListDocument } from './price-list-document';
import { getPriceList, priceListOptionsFrom } from './requests';

/** `/merchant/price-list/print` (S21 PL3, PR1): the price list on A4, printed by the browser. */
export function PriceListPrintPage() {
  const search = useSearchParams();
  const query = search.toString();
  const read = useCallback(
    () => getPriceList(priceListOptionsFrom(new URLSearchParams(query))),
    [query],
  );
  const { state, reload } = useMerchantRead(read);
  return (
    <DocumentPrintFrame
      // Back to the list with the options it was printed with (Q27).
      back={{ href: `/merchant/price-list?${query}`, label: tm('priceList.back') }}
      ready={state.status === 'ready'}
    >
      {state.status === 'ready' ? (
        <PriceListDocument list={state.data} />
      ) : (
        <MerchantPageStatus
          state={state}
          onRetry={() => void reload()}
          skeleton={<Skeleton className="h-96 w-full" />}
        />
      )}
    </DocumentPrintFrame>
  );
}
