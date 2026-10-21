import {
  formatRate,
  formatSignedUsd,
  formatSyp,
  formatUsd,
  type Statement,
  type StatementEntry,
  type StatementOrder,
} from '@vertex-digital/contracts';
import { formatDateTime } from '@/lib/format';
import { tm } from './i18n';

const monthFormat = new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'long',
});

/** `2026-10` as "تشرين الأول 2026" (a Damascus calendar month, ST1). */
export function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return monthFormat.format(new Date(Date.UTC(year ?? 2000, (number ?? 1) - 1, 15)));
}

function OrderLine({ order }: { order: StatementOrder }) {
  return (
    <span className="block">
      {tm('statements.orderLine')} <bdi dir="ltr">{order.number}</bdi> ·{' '}
      <bdi>{order.productNameAr}</bdi> × {order.quantity} · {order.gameNameAr}
      {order.fields.map((field) => (
        <span key={field.labelAr} className="block text-xs text-neutral-600">
          {field.labelAr}: <bdi dir="ltr">{field.value}</bdi>
        </span>
      ))}
    </span>
  );
}

/** ST2: what an entry was: the deposit, the order or the checkout's orders, the adjustment. */
function EntryDetails({ entry }: { entry: StatementEntry }) {
  if (entry.deposit) {
    const { method, referenceCode, syp } = entry.deposit;
    return (
      <span>
        {tm(`statements.methods.${method}`)} · {tm('statements.reference')}{' '}
        <bdi dir="ltr">{referenceCode}</bdi>
        {syp && (
          <span className="block text-xs text-neutral-600">
            {tm('statements.pounds', {
              amount: formatSyp(syp.amountUnits),
              rate: formatRate(syp.rate),
            })}
          </span>
        )}
      </span>
    );
  }
  if (entry.checkout) {
    return (
      <span className="flex flex-col gap-1">
        {entry.checkout.orders.map((order) => (
          <OrderLine key={order.id} order={order} />
        ))}
      </span>
    );
  }
  if (entry.order) return <OrderLine order={entry.order} />;
  if (entry.adjustment) {
    return (
      <span>
        {tm(`statements.categories.${entry.adjustment.category}`)}
        {entry.adjustment.reversal && ` · ${tm('statements.reversal')}`}
        {entry.adjustment.customerNote && (
          <span className="block text-xs text-neutral-600">{entry.adjustment.customerNote}</span>
        )}
      </span>
    );
  }
  return null;
}

function Money({ units, signed = false }: { units: number; signed?: boolean }) {
  return (
    <bdi dir="ltr" className="tabular-nums">
      {signed ? formatSignedUsd(units) : formatUsd(units)}
    </bdi>
  );
}

/**
 * The monthly statement as printed and shown (S21 ST2): the shop, the account's email and the
 * month ("حتى تاريخه" for this month), the opening balance, each kind's total, the closing
 * balance, then every entry of the month in time order with the balance after it. Black on white
 * like every printed page (PR1).
 */
export function StatementDocument({ statement }: { statement: Statement }) {
  return (
    <article
      data-testid="statement-document"
      className="flex flex-col gap-5 bg-white text-sm leading-snug text-neutral-950"
    >
      <header className="flex flex-col gap-1 border-b border-neutral-950 pb-3">
        <p className="text-xl font-bold">
          {tm('statements.title')} · {monthLabel(statement.month)}
          {statement.current && ` (${tm('statements.current')})`}
        </p>
        <p>
          {tm('statements.shop')}: <bdi>{statement.tradeName}</bdi>
        </p>
        <p>
          {tm('statements.email')}: <bdi dir="ltr">{statement.email}</bdi>
        </p>
        <p className="text-xs text-neutral-600">
          {tm('statements.generatedAt', { time: formatDateTime(statement.generatedAt) })}
        </p>
      </header>
      <dl className="flex max-w-md flex-col gap-1">
        <div className="flex justify-between gap-4 font-bold">
          <dt>{tm('statements.opening')}</dt>
          <dd>
            <Money units={statement.openingUsdUnits} />
          </dd>
        </div>
        {statement.totals.map((total) => (
          <div key={total.kind} className="flex justify-between gap-4">
            <dt>
              {tm(`statements.kinds.${total.kind}`)} ({total.count})
            </dt>
            <dd>
              <Money units={total.amountUnits} signed />
            </dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 font-bold">
          <dt>{statement.current ? tm('statements.closingToDate') : tm('statements.closing')}</dt>
          <dd>
            <Money units={statement.closingUsdUnits} />
          </dd>
        </div>
      </dl>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-bold">{tm('statements.entries')}</h2>
        {statement.entries.length === 0 ? (
          <p className="text-neutral-600">{tm('statements.entriesEmpty')}</p>
        ) : (
          <>
            {/* A phone reads one card per entry; wider screens and paper read the table. */}
            <ol className="flex flex-col sm:hidden print:hidden" data-testid="statement-cards">
              {statement.entries.map((entry, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered
                  key={index}
                  className="flex flex-col gap-1 border-b border-dashed border-neutral-300 py-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-bold">{tm(`statements.kinds.${entry.kind}`)}</span>
                    <span className="font-bold">
                      <Money units={entry.amountUnits} signed />
                    </span>
                  </div>
                  <EntryDetails entry={entry} />
                  <div className="flex items-baseline justify-between gap-3 text-xs text-neutral-600">
                    <span>{formatDateTime(entry.occurredAt)}</span>
                    <span>
                      {tm('statements.balanceAfter')} <Money units={entry.balanceAfterUnits} />
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="hidden overflow-x-auto sm:block print:block">
              <table className="w-full border-collapse text-start">
                <thead>
                  <tr className="border-b border-neutral-950 text-start">
                    <th className="py-1 pe-3 text-start font-bold">{tm('statements.date')}</th>
                    <th className="py-1 pe-3 text-start font-bold">{tm('statements.kind')}</th>
                    <th className="py-1 pe-3 text-start font-bold">{tm('statements.details')}</th>
                    <th className="py-1 pe-3 text-end font-bold">{tm('statements.amount')}</th>
                    <th className="py-1 text-end font-bold">{tm('statements.balanceAfter')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.entries.map((entry, index) => (
                    <tr
                      // Entries have no id of their own; their order is fixed (write order).
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered
                      key={index}
                      className="break-inside-avoid border-b border-dashed border-neutral-300 align-top"
                    >
                      <td className="py-1.5 pe-3 whitespace-nowrap">
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="py-1.5 pe-3">{tm(`statements.kinds.${entry.kind}`)}</td>
                      <td className="py-1.5 pe-3">
                        <EntryDetails entry={entry} />
                      </td>
                      <td className="py-1.5 pe-3 text-end">
                        <Money units={entry.amountUnits} signed />
                      </td>
                      <td className="py-1.5 text-end">
                        <Money units={entry.balanceAfterUnits} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </article>
  );
}
