'use client';

import {
  type MerchantPriceList,
  PRICE_LIST_CURRENCIES,
  PRICE_LIST_MODES,
} from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { DocumentPrintFrame } from './document-print-frame';
import { tm } from './i18n';
import { MerchantPageStatus, useMerchantRead } from './merchant-state';
import { PriceListDocument } from './price-list-document';
import { getPriceList, type PriceListOptions } from './requests';

const oneOf = <Value extends string>(
  values: readonly Value[],
  value: string | null,
  fallback: Value,
) => (values.includes(value as Value) ? (value as Value) : fallback);

/** The options of the price list page, as its link carries them. */
function optionsFrom(search: URLSearchParams): PriceListOptions {
  return {
    gameIds: (search.get('gameIds') ?? '').split(',').filter((id) => id.length > 0),
    mode: oneOf<MerchantPriceList['mode']>(PRICE_LIST_MODES, search.get('mode'), 'selling'),
    currency: oneOf<MerchantPriceList['currency']>(
      PRICE_LIST_CURRENCIES,
      search.get('currency'),
      'syp',
    ),
    unavailable: search.get('unavailable') === 'true',
  };
}

/** `/merchant/price-list/print` (S21 PL3, PR1): the price list on A4, printed by the browser. */
export function PriceListPrintPage() {
  const search = useSearchParams();
  const query = search.toString();
  const read = useCallback(() => getPriceList(optionsFrom(new URLSearchParams(query))), [query]);
  const { state, reload } = useMerchantRead(read);
  return (
    <DocumentPrintFrame
      back={{ href: '/merchant/price-list', label: tm('priceList.back') }}
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
