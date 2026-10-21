'use client';

import {
  formatAmountInput,
  formatSyp,
  formatUsd,
  type Order,
  type OrderSale,
  PRINT_PAPERS,
  type SaleCurrency,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { ClipboardCopyIcon, FileSpreadsheetIcon, PencilIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { saveBlob } from './download';
import { parseSellingPrice } from './form';
import { tm } from './i18n';
import { exportCodes, releaseCodes, setOrderSale } from './requests';
import { SellingPriceField } from './selling-price-field';

/** A sale as the merchant reads it: in its currency. */
export function saleText(sale: Pick<OrderSale, 'currency' | 'unitAmountUnits'>): string {
  return sale.currency === 'syp'
    ? tm('common.syp', { amount: formatSyp(sale.unitAmountUnits) })
    : ltr(formatUsd(sale.unitAmountUnits));
}

/**
 * The order page's merchant tools (S21 F34, F35, SP5, CR1–CR4): the order's selling price and its
 * edit, the receipt printed on 58 or 80 mm or A4, and for a code pack the codes printed, copied or
 * exported to Excel (each a logged release), then the release log. Loaded only for a merchant.
 */
export function OrderTools({ order, onChange }: { order: Order; onChange: () => Promise<void> }) {
  const delivered = order.codes.length > 0;
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    setFailure(null);
    setCopied(false);
    setBusy(true);
    const result = await releaseCodes(order.id, { purpose: 'copy' });
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    try {
      await navigator.clipboard.writeText(result.data.codes.map((code) => code.code).join('\n'));
      setCopied(true);
    } catch {
      setFailure('UNKNOWN');
    }
    await onChange();
  }

  async function exportFile() {
    setFailure(null);
    setBusy(true);
    const result = await exportCodes(order.id);
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    saveBlob(result.blob, result.fileName);
    await onChange();
  }

  return (
    <Card className="gap-4" data-testid="order-tools">
      <h2 className="text-lg font-bold">{tm('order.title')}</h2>
      <SaleEditor order={order} onChange={onChange} />
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <span className="text-sm font-medium">{tm('order.print')}</span>
        <div className="flex flex-wrap gap-2">
          {PRINT_PAPERS.map((paper) => (
            <Button
              key={paper}
              variant="outline"
              size="xl"
              render={
                <Link
                  href={`/orders/${order.id}/print?paper=${paper}&content=receipt`}
                  prefetch={false}
                  target="_blank"
                />
              }
            >
              <PrinterIcon aria-hidden="true" />
              {tm(`order.paper.${paper}`)}
            </Button>
          ))}
        </div>
      </div>
      {delivered && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="xl"
              render={
                <Link
                  href={`/orders/${order.id}/print?paper=80&content=codes`}
                  prefetch={false}
                  target="_blank"
                />
              }
            >
              <PrinterIcon aria-hidden="true" />
              {tm('order.printCodes')}
            </Button>
            <Button variant="outline" size="xl" disabled={busy} onClick={() => void copy()}>
              <ClipboardCopyIcon aria-hidden="true" />
              {tm('order.copyCodes')}
            </Button>
            <Button variant="outline" size="xl" disabled={busy} onClick={() => void exportFile()}>
              <FileSpreadsheetIcon aria-hidden="true" />
              {tm('order.exportCodes')}
            </Button>
          </div>
          {copied && (
            <p className="text-sm text-status-success-foreground" role="status">
              {tm('order.copied')}
            </p>
          )}
        </div>
      )}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      {order.codes.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-bold">{tm('order.log')}</h3>
          {order.codeReleases.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tm('order.logEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {order.codeReleases.map((entry) => (
                <li
                  key={`${entry.createdAt}:${entry.purpose}`}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <span>
                    {tm('order.logLine', {
                      purpose: tm(`order.purposes.${entry.purpose}`),
                      positions: entry.positions.join('، '),
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/** SP5: the order's selling price, set or changed later at the order's rate; no money moves. */
function SaleEditor({ order, onChange }: { order: Order; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [currency, setCurrency] = useState<SaleCurrency>(order.sale?.currency ?? 'syp');
  const [amount, setAmount] = useState(
    order.sale
      ? formatAmountInput(order.sale.currency === 'usd' ? 'USD' : 'SYP', order.sale.unitAmountUnits)
      : '',
  );
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const input = parseSellingPrice(currency, amount);
    setInvalid(input === undefined);
    if (input === undefined) return focusInvalid();
    setPending(true);
    const result = await setOrderSale(order.id, input);
    setPending(false);
    if (!result.ok) return setFailure(result.reason);
    setEditing(false);
    await onChange();
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          <span className="text-muted-foreground">{tm('order.sellingPrice')}: </span>
          {order.sale ? (
            <bdi className="font-bold">{saleText(order.sale)}</bdi>
          ) : (
            tm('order.sellingNone')
          )}
        </p>
        <Button variant="outline" size="xl" onClick={() => setEditing(true)}>
          <PencilIcon aria-hidden="true" />
          {tm('order.edit')}
        </Button>
      </div>
    );
  }
  return (
    <form ref={ref} className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <SellingPriceField
        currency={currency}
        amount={amount}
        invalid={invalid}
        label={tm('order.sellingPrice')}
        onCurrency={setCurrency}
        onAmount={setAmount}
      />
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <div className="flex gap-2">
        <Button type="submit" size="xl" disabled={pending}>
          {tm('order.save')}
        </Button>
        <Button type="button" variant="ghost" size="xl" onClick={() => setEditing(false)}>
          {tm('pos.cancel')}
        </Button>
      </div>
    </form>
  );
}
