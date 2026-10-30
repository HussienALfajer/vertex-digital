import { formatSyp, formatUsd, type MerchantPriceList } from '@vertex-digital/contracts';
import { formatDateTime } from '@/lib/format';
import { tm } from './i18n';
import { logoPath } from './requests';
import { TierLine } from './tier-parts';

type Row = MerchantPriceList['games'][number]['rows'][number];

/** PL1: the price in the chosen currency; USD when there is no rate for SYP. */
function PriceCell({ row, currency }: { row: Row; currency: MerchantPriceList['currency'] }) {
  if (!row.available || row.usdUnits === null) {
    return <span className="text-neutral-600">{tm('priceList.unavailableLine')}</span>;
  }
  const dollars = (
    <bdi dir="ltr" className="tabular-nums">
      {formatUsd(row.usdUnits)}
    </bdi>
  );
  if (row.sypUnits === null || currency === 'usd') return dollars;
  const pounds = <bdi>{tm('common.syp', { amount: formatSyp(row.sypUnits) })}</bdi>;
  if (currency === 'syp') return pounds;
  return (
    <span className="flex flex-col items-end">
      {pounds}
      <span className="text-xs text-neutral-600">{dollars}</span>
    </span>
  );
}

/**
 * The price list as printed (S21 PL2): the shop's name and logo, "قائمة الأسعار" with the date
 * and time and "الأسعار قابلة للتغيير", then each game's packs with their prices. Black on white
 * like every printed page (PR1); also the price list page's preview. Omitted packs are never
 * printed. S23 ID6, RC2: the tier's line under the shop's name, the logo twice the size for a tier
 * that grants it.
 */
export function PriceListDocument({ list }: { list: MerchantPriceList }) {
  return (
    <article
      data-testid="price-list-document"
      className="flex flex-col gap-4 bg-white text-sm leading-snug text-neutral-950"
    >
      <header className="flex items-center justify-between gap-4 border-b border-neutral-950 pb-3">
        <div className="flex flex-col gap-1">
          <p className="text-xl font-bold">
            <bdi>{list.tradeName}</bdi>
          </p>
          <TierLine tier={list.tier} print className="justify-start" />
          <p className="font-bold">
            {tm('priceList.title')} · {formatDateTime(list.generatedAt)}
          </p>
          <p className="text-xs text-neutral-600">{tm('priceList.changeable')}</p>
        </div>
        {list.logoFileId && (
          // biome-ignore lint/performance/noImgElement: the logo is the merchant's own, served by the API (S21 BR3).
          <img
            src={logoPath(list.logoFileId)}
            alt=""
            width={list.largeLogo ? 144 : 72}
            height={list.largeLogo ? 144 : 72}
            className={`${list.largeLogo ? 'size-36' : 'size-18'} object-contain`}
          />
        )}
      </header>
      {list.games.map((game) => (
        <section key={game.gameId} className="flex break-inside-avoid-page flex-col gap-1">
          <h2 className="border-b border-neutral-400 pb-1 text-base font-bold">{game.nameAr}</h2>
          <ul className="flex flex-col">
            {game.rows.map((row) => (
              <li
                key={row.productId}
                className="flex items-baseline justify-between gap-4 border-b border-dashed border-neutral-300 py-1.5"
              >
                <bdi>{row.nameAr}</bdi>
                <span className="text-end font-bold">
                  <PriceCell row={row} currency={list.currency} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
