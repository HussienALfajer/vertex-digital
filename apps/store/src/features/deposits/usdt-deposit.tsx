'use client';

import {
  type Deposit,
  type DepositUsdt,
  formatUsd,
  formatUsdtAmount,
  normalizeTxid,
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
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Progress } from '@vertex-digital/ui/components/progress';
import {
  CircleAlertIcon,
  ClockIcon,
  ExternalLinkIcon,
  HourglassIcon,
  SearchIcon,
  TimerIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { addressGroups, splitPayAmount } from './amounts';
import { CopyButton } from './copy-button';
import { Line, Panel } from './panel';
import { cancelDeposit, submitTxid } from './requests';
import { formatClock, useTimeLeft } from './use-time-left';

/**
 * A USDT deposit waiting for its transfer (S04 screens, rules U3, U8, U10): the exact amount with
 * its tail, the network, the address with its QR and groups, the warnings, the optional TXID, the
 * time left and cancel. The last TXID's failure shows above, in words.
 */
export function UsdtAwaiting({
  deposit,
  usdt,
  onChange,
}: {
  deposit: Deposit;
  usdt: DepositUsdt;
  onChange: (deposit: Deposit | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const expiryLeft = useTimeLeft(deposit.expiresAt);
  const { head, tail } = splitPayAmount(usdt.payAmount);

  async function cancel() {
    setBusy(true);
    const result = await cancelDeposit(deposit.id);
    setBusy(false);
    setCancelOpen(false);
    if (result.ok) return onChange(result.data);
    if (result.reason === 'DEPOSIT_STATE_CONFLICT') return onChange(null);
    setFailure(errorText(result.reason));
  }

  return (
    <div className="flex flex-col gap-6">
      {usdt.checkError && (
        <Callout
          tone="danger"
          icon={<CircleAlertIcon />}
          title={t(`deposits.usdt.checkErrors.${usdt.checkError}`)}
          description={t('deposits.usdt.checkErrorBody')}
        />
      )}
      {usdt.delayed && <DelayedNotice />}
      <Card className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{t('deposits.usdt.sendExactly')}</h2>
          <NetworkBadge method={usdt.method} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-3xl font-bold tabular-nums" dir="ltr">
            <span>{head}</span>
            <mark className="rounded-sm bg-accent px-0.5 text-accent-foreground">{tail}</mark>
            <span className="ms-2 text-lg font-medium text-muted-foreground">USDT</span>
          </p>
          <CopyButton value={usdt.payAmount} label={t('deposits.usdt.copyAmount')} />
        </div>
        <p className="text-sm text-muted-foreground">{t('deposits.usdt.tailNote')}</p>
      </Card>
      <Card className="gap-4">
        <h2 className="text-lg font-bold">{t('deposits.usdt.address')}</h2>
        <div className="flex w-fit self-center rounded-lg border border-border bg-white p-3">
          <QRCodeSVG
            value={usdt.address}
            size={176}
            role="img"
            aria-label={t('deposits.usdt.qrLabel')}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p
            dir="ltr"
            data-testid="usdt-address"
            className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-lg font-medium tabular-nums"
          >
            {addressGroups(usdt.address).map((group, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: groups repeat; the order is the key.
              <span key={index}>{group}</span>
            ))}
          </p>
          <CopyButton value={usdt.address} label={t('deposits.usdt.copyAddress')} />
        </div>
        <p className="text-sm font-medium">{t('deposits.usdt.copyFromHere')}</p>
      </Card>
      <Callout
        tone="warning"
        icon={<TriangleAlertIcon />}
        title={t('deposits.usdt.feeWarningTitle')}
        description={t('deposits.usdt.feeWarning')}
      />
      <p className="flex items-center gap-2 text-base">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full bg-status-success-foreground"
        />
        {t('deposits.usdt.waiting')}
      </p>
      <TxidForm deposit={deposit} onChange={onChange} />
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <TimerIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="tabular-nums">
          {t('deposits.usdt.expiresIn', { time: formatClock(expiryLeft) })}
        </span>
      </p>
      {failure && <FormAlert>{failure}</FormAlert>}
      <Button variant="ghost" size="xl" disabled={busy} onClick={() => setCancelOpen(true)}>
        {t('deposits.pending.cancel')}
      </Button>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deposits.cancel.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deposits.usdt.cancelBody')}</AlertDialogDescription>
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

/** "سرّع التحقق" (rule U8): the TXID or explorer link, checked here first, normalized by the API. */
function TxidForm({
  deposit,
  onChange,
}: {
  deposit: Deposit;
  onChange: (deposit: Deposit | null) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (normalizeTxid(text) === null) return setError(errorText('TXID_INVALID'));
    setError(null);
    setBusy(true);
    const result = await submitTxid(deposit.id, text.trim());
    setBusy(false);
    if (result.ok) return onChange(result.data);
    if (result.reason === 'DEPOSIT_STATE_CONFLICT') return onChange(null);
    setError(errorText(result.reason));
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field invalid={!!error}>
          <FieldLabel>{t('deposits.usdt.txidLabel')}</FieldLabel>
          <Input
            name="txid"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
            className="h-11 text-md"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
          <FieldDescription>{t('deposits.usdt.txidHint')}</FieldDescription>
          <FieldError match={!!error}>{error}</FieldError>
        </Field>
        <Button type="submit" variant="outline" size="xl" disabled={busy || !text.trim()}>
          <SearchIcon />
          {busy ? t('deposits.pending.submitting') : t('deposits.usdt.txidSubmit')}
        </Button>
      </form>
    </Card>
  );
}

/**
 * A USDT deposit being checked (rules U9, U11): searching for the TXID, waiting for the network's
 * confirmations, or in review with the reason in words and the review ETA.
 */
export function UsdtChecking({ deposit, usdt }: { deposit: Deposit; usdt: DepositUsdt }) {
  const declared = (
    <Line label={t('deposits.usdt.payAmount')}>
      <bdi dir="ltr">{usdt.payAmount} USDT</bdi>
    </Line>
  );
  if (usdt.checkStatus === 'review') {
    return (
      <Panel icon={HourglassIcon} tone="warning" title={t('deposits.usdt.reviewTitle')}>
        {reviewSentences(usdt).map((sentence) => (
          <p key={sentence} className="text-base font-medium tabular-nums">
            {sentence}
          </p>
        ))}
        <p className="flex items-start gap-2 text-base">
          <ClockIcon className="mt-1 size-4 shrink-0" aria-hidden="true" />
          {!deposit.eta
            ? t('deposits.eta.unknown')
            : deposit.eta.state === 'closed'
              ? t('deposits.eta.closed', { date: formatDateTime(deposit.eta.opensAt) })
              : t('deposits.eta.open', { minutes: deposit.eta.minutes })}
        </p>
        <dl className="flex flex-col gap-2">
          {declared}
          <TxidLine usdt={usdt} />
        </dl>
      </Panel>
    );
  }
  const confirming = usdt.checkStatus === 'confirming';
  const confirmations = Math.min(usdt.confirmations ?? 0, usdt.requiredConfirmations);
  return (
    <div className="flex flex-col gap-6">
      {usdt.delayed && <DelayedNotice />}
      <Panel
        icon={confirming ? HourglassIcon : SearchIcon}
        tone="muted"
        title={t(confirming ? 'deposits.usdt.confirmingTitle' : 'deposits.usdt.searchingTitle')}
      >
        {confirming ? (
          <div className="flex flex-col gap-2">
            <Progress
              value={confirmations}
              max={usdt.requiredConfirmations}
              aria-label={t('deposits.usdt.confirmationsLabel')}
            />
            <p className="text-sm text-muted-foreground tabular-nums">
              {t('deposits.usdt.confirmations', {
                count: confirmations,
                required: usdt.requiredConfirmations,
              })}
            </p>
          </div>
        ) : (
          <p className="text-base text-muted-foreground">{t('deposits.usdt.searchingBody')}</p>
        )}
        <dl className="flex flex-col gap-2">
          {declared}
          <TxidLine usdt={usdt} />
        </dl>
        <p className="text-sm text-muted-foreground">{t('deposits.usdt.autoRefresh')}</p>
      </Panel>
    </div>
  );
}

/** The review's reasons in plain words (rule U11), e.g. the amount received against the asked. */
function reviewSentences(usdt: DepositUsdt): string[] {
  return usdt.reviewReasons.map((reason) => {
    if (reason === 'amount_mismatch' && usdt.receivedAmountUnits !== null) {
      return t('deposits.usdt.review.amount_mismatch', {
        received: formatUsdtAmount(usdt.receivedAmountUnits),
        asked: usdt.payAmount,
      });
    }
    return t(`deposits.usdt.review.${reason === 'amount_mismatch' ? 'amount_unknown' : reason}`);
  });
}

/** The TXID, shortened, with its explorer link. */
export function TxidLine({ usdt }: { usdt: DepositUsdt }) {
  if (!usdt.txid) return null;
  return (
    <Line label={t('deposits.usdt.txid')}>
      <ExplorerLink usdt={usdt}>
        <bdi dir="ltr">
          {usdt.txid.slice(0, 8)}…{usdt.txid.slice(-6)}
        </bdi>
      </ExplorerLink>
    </Line>
  );
}

function ExplorerLink({ usdt, children }: { usdt: DepositUsdt; children: ReactNode }) {
  if (!usdt.explorerUrl) return children;
  return (
    <a
      href={usdt.explorerUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-sm underline underline-offset-4"
      aria-label={t('deposits.usdt.explorer')}
    >
      {children}
      <ExternalLinkIcon className="size-4" aria-hidden="true" />
    </a>
  );
}

/** Credited USDT: the credit, the TXID link and the time. */
export function UsdtCreditedLines({ deposit, usdt }: { deposit: Deposit; usdt: DepositUsdt }) {
  return (
    <>
      <Line label={t('deposits.usdt.payAmount')}>
        <bdi dir="ltr">{usdt.payAmount} USDT</bdi>
      </Line>
      {deposit.credited && deposit.credited.usdUnits !== deposit.declaredUsdUnits && (
        <Line label={t('deposits.detail.amount')}>
          <bdi dir="ltr">{formatUsd(deposit.declaredUsdUnits)}</bdi>
        </Line>
      )}
      <TxidLine usdt={usdt} />
    </>
  );
}

export function NetworkBadge({ method }: { method: DepositUsdt['method'] }) {
  return <Badge tone="info">{t(`deposits.usdt.networks.${method}`)}</Badge>;
}

/** Rule U12: the network's scanner is late; the deposit keeps its page. */
function DelayedNotice() {
  return (
    <Callout
      tone="warning"
      icon={<ClockIcon />}
      title={t('deposits.usdt.delayedTitle')}
      description={t('deposits.usdt.delayedBody')}
    />
  );
}
