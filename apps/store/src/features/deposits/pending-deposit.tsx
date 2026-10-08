'use client';

import {
  type Deposit,
  formatAmountInput,
  formatRate,
  formatUsd,
  type QuoteOffer,
  quoteOfferSchema,
} from '@vertex-digital/contracts';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vertex-digital/ui/components/alert-dialog';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { ImageUpIcon, InfoIcon, LockIcon, TimerIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { amountText, usdText } from './amounts';
import { CopyButton } from './copy-button';
import { ReceiptPicker } from './receipt-picker';
import { cancelDeposit, requoteDeposit, submitReceipt } from './requests';
import { formatClock, useTimeLeft } from './use-time-left';

/**
 * A deposit waiting for its receipt (rules SC7–SC11): where to send, the code for the transfer
 * note, the receipt, and for SYP the quote's countdown. A submission after the quote expired
 * answers `QUOTE_EXPIRED` with the current rate: the customer accepts it (requote, then submit
 * again) or cancels (SC9, SC10).
 */
export function PendingDeposit({
  deposit,
  onChange,
}: {
  deposit: Deposit;
  onChange: (deposit: Deposit | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [offer, setOffer] = useState<QuoteOffer | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const quoteLeft = useTimeLeft(deposit.rateFixed ? null : (deposit.quote?.expiresAt ?? null));
  const expiryLeft = useTimeLeft(deposit.expiresAt);

  /** Sends the receipt at `rateId`; a changed quote opens the offer instead. */
  async function send(rateId: string | null) {
    if (!file) return setFailure(t('deposits.receipt.required'));
    setFailure(null);
    setBusy(true);
    const result = await submitReceipt(deposit.id, file, rateId);
    setBusy(false);
    if (result.ok) return onChange(result.data);
    const quote = quoteOfferSchema.safeParse(result.details);
    if (result.reason === 'QUOTE_EXPIRED' && quote.success) return setOffer(quote.data);
    // Another tab, the expiry job or the admin moved the deposit on: show where it is now.
    if (result.reason === 'DEPOSIT_STATE_CONFLICT') return onChange(null);
    setFailure(errorText(result.reason));
  }

  /** "أوافق وأرسل": a new quote at the current rate, then the receipt at that rate. */
  async function acceptOffer(accepted: QuoteOffer) {
    setBusy(true);
    const requoted = await requoteDeposit(deposit.id);
    if (!requoted.ok) {
      setBusy(false);
      setOffer(null);
      if (requoted.reason === 'DEPOSIT_STATE_CONFLICT') return onChange(null);
      return setFailure(errorText(requoted.reason));
    }
    const quote = requoted.data.quote;
    onChange(requoted.data);
    // The rate moved again between the offer and the requote: show the new one first.
    if (quote && quote.rateId !== accepted.rateId) {
      setBusy(false);
      return setOffer({
        rateId: quote.rateId,
        rate: quote.rate,
        declaredUsdUnits: requoted.data.declaredUsdUnits,
      });
    }
    setOffer(null);
    await send(quote?.rateId ?? null);
  }

  async function cancel() {
    setBusy(true);
    const result = await cancelDeposit(deposit.id);
    setBusy(false);
    setCancelOpen(false);
    if (result.ok) return onChange(result.data);
    if (result.reason === 'DEPOSIT_STATE_CONFLICT') return onChange(null);
    setFailure(errorText(result.reason));
  }

  const payTo = deposit.payTo;
  const quoteExpired = !!deposit.quote && !deposit.rateFixed && quoteLeft === 0;
  return (
    <div className="flex flex-col gap-6">
      {deposit.receiptRequest && (
        <Callout
          tone="info"
          icon={<InfoIcon />}
          title={t('deposits.pending.receiptRequested')}
          description={deposit.receiptRequest.note ?? t('deposits.pending.receiptRequestedBody')}
        />
      )}
      {deposit.quote && (
        <p
          className={
            quoteExpired
              ? 'flex items-center gap-2 text-sm font-medium text-status-warning-foreground'
              : 'flex items-center gap-2 text-sm text-muted-foreground'
          }
        >
          <LockIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">
            {deposit.rateFixed
              ? t('deposits.pending.rateFixed', { rate: formatRate(deposit.quote.rate) })
              : quoteExpired
                ? t('deposits.pending.quoteExpired')
                : t('deposits.pending.quoteLeft', {
                    rate: formatRate(deposit.quote.rate),
                    time: formatClock(quoteLeft),
                  })}
          </span>
        </p>
      )}
      <Step number={1} title={t('deposits.pending.step1')}>
        {payTo ? (
          <>
            <CopyLine label={t('deposits.pending.accountName')} value={payTo.accountName} />
            <CopyLine label={t('deposits.pending.accountNumber')} value={payTo.accountNumber} ltr />
            <CopyLine
              label={t('deposits.pending.amount')}
              value={formatAmountInput(deposit.currency, deposit.declaredAmountUnits)}
              shown={amountText(deposit.currency, deposit.declaredAmountUnits)}
              large
            />
            {deposit.currency === 'SYP' && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {t('deposits.pending.youGet', { amount: usdText(deposit.declaredUsdUnits) })}
              </p>
            )}
            {payTo.qrUrl && (
              <button
                type="button"
                className="flex w-fit flex-col items-center gap-2 self-center rounded-lg border border-border bg-white p-3"
                onClick={() => setQrOpen(true)}
                aria-label={t('deposits.pending.qrEnlarge')}
              >
                {/* biome-ignore lint/performance/noImgElement: a private API image, never optimized. */}
                <img src={payTo.qrUrl} alt="" className="size-40 object-contain" />
                <span className="text-xs text-neutral-900">{t('deposits.pending.qrTap')}</span>
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('deposits.pending.noAccount')}</p>
        )}
      </Step>
      <Step number={2} title={t('deposits.pending.step2')}>
        <div className="flex items-center justify-between gap-3">
          <bdi dir="ltr" className="text-3xl font-bold tabular-nums">
            {deposit.referenceCode}
          </bdi>
          <CopyButton value={deposit.referenceCode} label={t('deposits.pending.copyReference')} />
        </div>
        <p className="text-sm font-medium">{t('deposits.pending.referenceNote')}</p>
      </Step>
      <Step number={3} title={t('deposits.pending.step3')}>
        <ReceiptPicker file={file} onFile={setFile} disabled={busy} />
      </Step>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <TimerIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="tabular-nums">
          {t('deposits.pending.expiresIn', { time: formatClock(expiryLeft) })}
        </span>
      </p>
      {failure && <FormAlert>{failure}</FormAlert>}
      <div className="flex flex-col gap-3">
        <Button
          size="xl"
          disabled={busy || !file}
          onClick={() => void send(deposit.quote?.rateId ?? null)}
        >
          <ImageUpIcon />
          {busy ? t('deposits.pending.submitting') : t('deposits.pending.submit')}
        </Button>
        <Button variant="ghost" size="xl" disabled={busy} onClick={() => setCancelOpen(true)}>
          {t('deposits.pending.cancel')}
        </Button>
      </div>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent closeLabel={t('deposits.close')}>
          <DialogHeader>
            <DialogTitle>{t('deposits.pending.qrTitle')}</DialogTitle>
          </DialogHeader>
          {payTo?.qrUrl && (
            <div className="flex justify-center rounded-lg bg-white p-4">
              {/* biome-ignore lint/performance/noImgElement: a private API image, never optimized. */}
              <img
                src={payTo.qrUrl}
                alt={t('deposits.pending.qrTitle')}
                className="w-full max-w-80 object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={offer !== null} onOpenChange={(open) => !open && !busy && setOffer(null)}>
        <DialogContent closeLabel={t('deposits.close')}>
          <DialogHeader>
            <DialogTitle>{t('deposits.requote.title')}</DialogTitle>
            <DialogDescription>{t('deposits.requote.body')}</DialogDescription>
          </DialogHeader>
          {offer && (
            <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-muted-foreground">{t('deposits.requote.rate')}</dt>
                <dd className="text-lg font-bold tabular-nums">{formatRate(offer.rate)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-muted-foreground">{t('deposits.requote.usd')}</dt>
                <dd className="text-lg font-bold tabular-nums">
                  <bdi dir="ltr">{formatUsd(offer.declaredUsdUnits)}</bdi>
                </dd>
              </div>
            </dl>
          )}
          <DialogFooter>
            <Button size="xl" disabled={busy} onClick={() => offer && void acceptOffer(offer)}>
              {busy ? t('deposits.pending.submitting') : t('deposits.requote.accept')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deposits.cancel.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deposits.cancel.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="xl" />}>
              {t('deposits.cancel.keep')}
            </AlertDialogClose>
            <Button variant="destructive" size="xl" disabled={busy} onClick={() => void cancel()}>
              {t('deposits.cancel.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <Card className="gap-4">
      <h2 className="flex items-center gap-3 text-lg font-bold">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-sm text-accent-foreground tabular-nums"
        >
          {number}
        </span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

/** A value to type in Sham Cash, with its copy button. */
function CopyLine({
  label,
  value,
  shown,
  ltr,
  large,
}: {
  label: string;
  value: string;
  shown?: string;
  ltr?: boolean;
  large?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span
          dir={ltr ? 'ltr' : undefined}
          className={
            large
              ? 'text-2xl font-bold break-all tabular-nums'
              : 'text-base font-medium break-all tabular-nums'
          }
        >
          {shown ?? value}
        </span>
      </div>
      <CopyButton value={value} label={t('deposits.pending.copyLabel', { label })} />
    </div>
  );
}
