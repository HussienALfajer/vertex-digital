import {
  type CatalogImage,
  formatSyp,
  formatUsd,
  type MerchantPriceList,
  type MerchantPriceListGame,
} from '@vertex-digital/contracts';
import { Gamepad2Icon } from 'lucide-react';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { formatDateTime } from '@/lib/format';
import { tm } from './i18n';
import { logoPath } from './requests';
import { TierLine } from './tier-parts';

type Row = MerchantPriceList['games'][number]['rows'][number];

/** A game's cover by its id (from the public search index), where it has one. */
export type PriceListCovers = ReadonlyMap<string, Pick<CatalogImage, 'url' | 'width' | 'height'>>;

/** PL1: the price in the chosen currency, USD first when both show; USD alone without a rate. */
function PriceCell({ row, currency }: { row: Row; currency: MerchantPriceList['currency'] }) {
  if (!row.available || row.usdUnits === null) {
    return <span className="font-normal text-neutral-600">{tm('priceList.unavailableLine')}</span>;
  }
  const dollars = (
    <bdi dir="ltr" className="tabular-nums">
      {formatUsd(row.usdUnits)}
    </bdi>
  );
  if (row.sypUnits === null || currency === 'usd') return dollars;
  const pounds = (
    <bdi className="tabular-nums">{tm('common.syp', { amount: formatSyp(row.sypUnits) })}</bdi>
  );
  if (currency === 'syp') return pounds;
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
      {dollars}
      <span className="text-neutral-500">·</span>
      <span className="font-normal text-neutral-700">{pounds}</span>
    </span>
  );
}

/** The shop's line at the foot of every page: the date, "قابلة للتغيير", its WhatsApp. */
function Footer({ list, page }: { list: MerchantPriceList; page?: string }) {
  return (
    <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-400 pt-2 text-xs text-neutral-700">
      <span>
        {formatDateTime(list.generatedAt)} · {tm('priceList.changeable')}
      </span>
      <span className="flex items-center gap-3">
        {list.whatsapp && (
          <span>
            {tm('priceList.whatsapp')}{' '}
            <bdi dir="ltr" className="tabular-nums">
              {list.whatsapp}
            </bdi>
          </span>
        )}
        {page && <span className="tabular-nums">{page}</span>}
      </span>
    </footer>
  );
}

/**
 * The price list as printed (S21 PL2; owner, 2026-10-30): the shop's name and logo with its tier's
 * line, "قائمة الأسعار" with the date and time, then each game with its cover beside its title and
 * its packs in a table of alternating rows (USD before SYP when both show), and a footer with the
 * date, "الأسعار قابلة للتغيير" and the shop's WhatsApp. Black on white like every printed page
 * (PR1). `games` and `page` make it one A4 page of the preview: the header on the first only.
 * Omitted packs are never printed. S23 ID6, RC2: the tier's line, a larger logo for a tier that
 * grants it.
 */
export function PriceListDocument({
  list,
  covers = new Map(),
  games = list.games,
  page,
}: {
  list: MerchantPriceList;
  covers?: PriceListCovers;
  games?: MerchantPriceListGame[];
  /** "صفحة 1 من 3" on a preview page; the whole list without it. */
  page?: { number: number; count: number };
}) {
  const first = !page || page.number === 1;
  return (
    <article
      data-testid="price-list-document"
      className="flex h-full flex-col gap-4 bg-white text-sm leading-snug text-neutral-950"
    >
      {first && (
        <header className="flex items-start justify-between gap-4 border-b-2 border-neutral-950 pb-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xl font-bold">
              <bdi>{list.tradeName}</bdi>
            </p>
            <TierLine tier={list.tier} print className="justify-start" />
            <p className="font-bold">
              {tm('priceList.title')} · {formatDateTime(list.generatedAt)}
            </p>
          </div>
          {list.logoFileId && (
            // biome-ignore lint/performance/noImgElement: the logo is the merchant's own, served by the API (S21 BR3).
            <img
              src={logoPath(list.logoFileId)}
              alt=""
              width={list.largeLogo ? 144 : 72}
              height={list.largeLogo ? 144 : 72}
              className={`${list.largeLogo ? 'size-36' : 'size-18'} shrink-0 object-contain`}
            />
          )}
        </header>
      )}
      {games.map((game) => {
        const cover = covers.get(game.gameId);
        return (
          <section key={game.gameId} className="flex break-inside-avoid-page flex-col gap-2">
            <h2 className="flex items-center gap-2 text-base font-bold">
              {cover ? (
                <CatalogPicture image={cover} sizes="40px" className="size-9 shrink-0" />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-neutral-300 text-neutral-500">
                  <Gamepad2Icon className="size-4" aria-hidden="true" />
                </span>
              )}
              <bdi>{game.nameAr}</bdi>
            </h2>
            <table className="w-full border-collapse">
              <thead className="sr-only">
                <tr>
                  <th>{tm('priceList.pack')}</th>
                  <th>{tm('priceList.price')}</th>
                </tr>
              </thead>
              <tbody>
                {game.rows.map((row) => (
                  <tr key={row.productId} className="odd:bg-neutral-100">
                    <td className="px-2 py-1.5">
                      <bdi>{row.nameAr}</bdi>
                    </td>
                    <td className="px-2 py-1.5 text-end font-bold">
                      <PriceCell row={row} currency={list.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      <Footer
        list={list}
        page={
          page && page.count > 1
            ? tm('priceList.pageOf', { page: page.number, pages: page.count })
            : undefined
        }
      />
    </article>
  );
}
