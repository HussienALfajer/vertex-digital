'use client';

import {
  formatSyp,
  formatUsd,
  type OrderPrint,
  PRINT_PAPERS,
  type PrintPaper,
  printPaperSchema,
  type ReleasedCodes,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { VerificationQr } from '@/features/orders/verification-qr';
import { formatDateTime } from '@/lib/format';
import { tm } from './i18n';
import { getOrderPrint, logoPath, releaseCodes } from './requests';

/**
 * The page rule of each paper (S21 PR1): thermal rolls are as long as the receipt, A4 is portrait
 * with margins. Constant strings written here, never data.
 */
const PAGE_RULES: Record<PrintPaper, string> = {
  '58': '@page { size: 58mm auto; margin: 2mm; }',
  '80': '@page { size: 80mm auto; margin: 3mm; }',
  a4: '@page { size: A4 portrait; margin: 15mm; }',
};

const WIDTHS: Record<PrintPaper, string> = {
  '58': 'max-w-[58mm]',
  '80': 'max-w-[80mm]',
  a4: 'max-w-[180mm]',
};

type Content = 'receipt' | 'codes';

type State =
  | { status: 'loading' }
  | { status: 'failed'; codes: boolean }
  | { status: 'missing' }
  | { status: 'ready'; print: OrderPrint; codes: ReleasedCodes['codes'] | null };

/** The receipt's price as printed: the sale's currency, or the retail dollars. */
function priceText(price: NonNullable<OrderPrint['price']>, amount: number): string {
  return price.currency === 'syp'
    ? tm('common.syp', { amount: formatSyp(amount) })
    : formatUsd(amount);
}

/**
 * `/orders/[id]/print?paper=58|80|a4&content=receipt|codes` (S21 PR1–PR3): black on white, no
 * header or footer, an on-screen bar with "طباعة / حفظ PDF" and the paper, hidden when printing.
 * The receipt shows the shop (or the store), the order and the selling price, never the price a
 * merchant paid (BR1), and the verification QR (VF1). The codes ask for a release with
 * `purpose: print` on each opening, so every print is logged (CR1).
 */
export function PrintPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const paper = printPaperSchema.catch('80').parse(search.get('paper') ?? '80');
  const content: Content = search.get('content') === 'codes' ? 'codes' : 'receipt';
  const [state, setState] = useState<State>({ status: 'loading' });
  const asked = useRef<string | null>(null);

  useEffect(() => {
    // One read (and one logged release) per order and content shown.
    const key = `${id}:${content}`;
    if (asked.current === key) return;
    asked.current = key;
    void (async () => {
      const result = await getOrderPrint(id);
      if (!result.ok && result.reason === 'UNAUTHORIZED') {
        router.replace(`/sign-in?next=${encodeURIComponent(`/orders/${id}/print`)}`);
        return;
      }
      if (!result.ok) {
        return setState(
          result.reason === 'NOT_FOUND'
            ? { status: 'missing' }
            : { status: 'failed', codes: false },
        );
      }
      if (content === 'receipt') {
        return setState({ status: 'ready', print: result.data, codes: null });
      }
      const released = await releaseCodes(id, { purpose: 'print' });
      if (!released.ok) return setState({ status: 'failed', codes: true });
      setState({ status: 'ready', print: result.data, codes: released.data.codes });
    })();
  }, [id, content, router]);

  if (state.status === 'missing') notFound();
  return (
    <div
      data-print-page
      className="flex flex-col items-center gap-6 bg-white px-4 py-6 text-neutral-950"
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant page rule per paper, no input. */}
      <style dangerouslySetInnerHTML={{ __html: PAGE_RULES[paper] }} />
      <div className="flex w-full max-w-2xl flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-300 p-3 print:hidden">
        <fieldset className="flex flex-wrap gap-2" aria-label={tm('print.paper')}>
          {PRINT_PAPERS.map((option) => (
            <Button
              key={option}
              size="xl"
              variant={option === paper ? 'primary' : 'outline'}
              aria-pressed={option === paper}
              render={
                <Link
                  href={`/orders/${id}/print?paper=${option}&content=${content}`}
                  prefetch={false}
                  replace
                />
              }
            >
              {tm(`order.paper.${option}`)}
            </Button>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="xl"
            render={<Link href={`/orders/${id}`} prefetch={false} />}
          >
            {tm('print.back')}
          </Button>
          <Button size="xl" disabled={state.status !== 'ready'} onClick={() => window.print()}>
            <PrinterIcon aria-hidden="true" />
            {tm('print.bar')}
          </Button>
        </div>
      </div>
      {state.status === 'loading' && <Skeleton className="h-96 w-full max-w-[80mm]" />}
      {state.status === 'failed' && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={state.codes ? tm('print.codesFailed') : tm('print.loadFailed')}
          action={
            <Button variant="outline" size="xl" onClick={() => window.location.reload()}>
              {tm('common.retry')}
            </Button>
          }
        />
      )}
      {state.status === 'ready' && (
        <div className={`w-full ${WIDTHS[paper]} font-sans`}>
          {state.codes ? (
            <CodesPrint print={state.print} codes={state.codes} />
          ) : (
            <ReceiptPrint print={state.print} />
          )}
        </div>
      )}
    </div>
  );
}

/** PR2: the receipt as the thermal printer or A4 prints it. Also the settings page's preview. */
export function ReceiptPrint({ print, logoUrl }: { print: OrderPrint; logoUrl?: string | null }) {
  const logo =
    logoUrl !== undefined ? logoUrl : print.logoFileId ? logoPath(print.logoFileId) : null;
  return (
    <article className="flex flex-col gap-2 text-sm leading-snug text-neutral-950">
      <header className="flex flex-col items-center gap-1 border-b border-dashed border-neutral-950 pb-2 text-center">
        {logo && (
          // biome-ignore lint/performance/noImgElement: the logo is the merchant's own, served by the API (S21 BR3).
          <img
            src={logo}
            alt=""
            width={64}
            height={64}
            className="size-16 object-contain grayscale"
          />
        )}
        <p className="text-base font-bold">
          {print.issuer.kind === 'merchant' ? (
            <bdi>{print.issuer.tradeName}</bdi>
          ) : (
            'VERTEX DIGITAL'
          )}
        </p>
        {print.whatsapp && (
          <p>
            {tm('print.whatsapp')} <bdi dir="ltr">{print.whatsapp}</bdi>
          </p>
        )}
      </header>
      <dl className="flex flex-col gap-1">
        <PrintLine label={tm('print.order')}>
          <bdi dir="ltr">{print.orderNumber}</bdi>
        </PrintLine>
        <PrintLine label={tm('print.date')}>{formatDateTime(print.createdAt)}</PrintLine>
        <p className="font-bold">
          <bdi>{print.product.nameAr}</bdi> · {print.game.nameAr}
        </p>
        {print.fields.map((field) => (
          <PrintLine key={field.labelAr} label={field.labelAr}>
            <bdi dir="ltr">{field.value}</bdi>
          </PrintLine>
        ))}
        <PrintLine label={tm('print.quantity')}>{print.quantity}</PrintLine>
        <PrintLine label={tm('print.delivered')}>{print.deliveredQuantity}</PrintLine>
        <PrintLine label={tm('print.state')}>{tm(`print.stages.${print.stage}`)}</PrintLine>
        {print.price && (
          <PrintLine label={tm('print.price')}>
            <bdi dir={print.price.currency === 'syp' ? undefined : 'ltr'} className="font-bold">
              {priceText(print.price, print.price.totalAmountUnits)}
            </bdi>
          </PrintLine>
        )}
      </dl>
      <footer className="flex flex-col items-center gap-1 border-t border-dashed border-neutral-950 pt-2 text-center text-xs">
        <VerificationQr code={print.verificationCode} size={112} label={tm('print.verify')} />
        <p>{tm('print.verify')}</p>
      </footer>
    </article>
  );
}

/** PR3: one block per code with the pack, the code large, the redemption steps and the order. */
function CodesPrint({ print, codes }: { print: OrderPrint; codes: ReleasedCodes['codes'] }) {
  return (
    <div className="flex flex-col">
      {codes.map((code) => (
        <article
          key={code.id}
          className="flex break-inside-avoid flex-col gap-1 border-b border-dashed border-neutral-950 py-3 text-sm text-neutral-950"
        >
          <p className="font-bold">
            <bdi>{print.product.nameAr}</bdi> · {tm('print.codeTitle', { position: code.position })}
          </p>
          <p dir="ltr" className="tabular-nums text-lg font-bold break-all">
            {code.code}
          </p>
          {print.product.redemptionAr && (
            <p className="text-xs whitespace-pre-line">{print.product.redemptionAr}</p>
          )}
          <p className="text-xs">
            {tm('print.order')} <bdi dir="ltr">{print.orderNumber}</bdi>
          </p>
        </article>
      ))}
    </div>
  );
}

function PrintLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}
