'use client';

import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { getSearchIndex } from '@/features/search/requests';
import { DocumentPrintFrame } from './document-print-frame';
import { tm } from './i18n';
import { MerchantPageStatus, useMerchantRead } from './merchant-state';
import { type PriceListCovers, PriceListDocument } from './price-list-document';
import { getPriceList, priceListOptionsFrom } from './requests';

/** `/merchant/price-list/print` (S21 PL3, PR1): the price list on A4, printed by the browser. */
export function PriceListPrintPage() {
  const search = useSearchParams();
  const query = search.toString();
  const read = useCallback(async () => {
    const [list, index] = await Promise.all([
      getPriceList(priceListOptionsFrom(new URLSearchParams(query))),
      getSearchIndex(),
    ]);
    if (!list.ok) return list;
    // The games' covers beside their titles; a failed index prints the names alone.
    const covers: PriceListCovers = new Map(
      index.ok
        ? index.data.games.flatMap((game) => (game.cover ? [[game.id, game.cover]] : []))
        : [],
    );
    return { ok: true as const, data: { list: list.data, covers } };
  }, [query]);
  const { state, reload } = useMerchantRead(read);
  return (
    <DocumentPrintFrame
      // Back to the list with the options it was printed with (Q27).
      back={{ href: `/merchant/price-list?${query}`, label: tm('priceList.back') }}
      ready={state.status === 'ready'}
    >
      {state.status === 'ready' ? (
        <PriceListDocument list={state.data.list} covers={state.data.covers} />
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
