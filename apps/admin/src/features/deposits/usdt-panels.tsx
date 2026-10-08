import { Link } from '@tanstack/react-router';
import {
  type AdminDeposit,
  type AdminDepositUsdt,
  type ApproveUsdtDeposit,
  approveUsdtDepositSchema,
  type DepositFlagCode,
  floorToWholeCents,
  formatUsd,
  formatUsdtAmount,
  type UsdtCandidate,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  Textarea,
} from '@vertex-digital/ui';
import { ExternalLinkIcon, ShieldCheckIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, ltr } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { STATUS_TONES } from './deposit-labels';
import { useApproveUsdtDeposit } from './deposits.queries';
import { Fact } from './fact';

/*
 * A USDT deposit as the admin reviews it (S04 screens, rules U11, U15): its facts, the TXID, the
 * bound transfer with the difference, the candidate deposits and the approval.
 */

/** A USDT amount in USD units, 4 decimals, kept whole in a sentence (`24.0037 USDT`). */
export const usdtText = (units: number) => ltr(`${formatUsdtAmount(units)} USDT`);

/** The network, the address shown, the amounts, the TXID with its source, and the times. */
export function UsdtFacts({ deposit, usdt }: { deposit: AdminDeposit; usdt: AdminDepositUsdt }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('deposits.detail.facts')}</CardTitle>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Fact label={t('deposits.usdt.network')}>{t(`wallets.methods.${usdt.method}`)}</Fact>
        <Fact label={t('deposits.usdt.checkStatus')}>
          {t(`deposits.usdt.checkStatuses.${usdt.checkStatus}`)}
        </Fact>
        <Fact label={t('deposits.usdt.payAmount')}>{usdtText(usdt.payAmountUnits)}</Fact>
        <Fact label={t('deposits.usdt.tail')}>{usdtText(usdt.tailUnits)}</Fact>
        <Fact label={t('deposits.detail.declared')}>
          <bdi dir="ltr">{formatUsd(deposit.declaredUsdUnits)}</bdi>
        </Fact>
        <Fact label={t('deposits.detail.created')}>{formatDateTime(deposit.createdAt)}</Fact>
        <div className="col-span-2 flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('deposits.usdt.address')}</dt>
          <dd className="font-medium break-all" dir="ltr">
            <code>{usdt.address}</code>
          </dd>
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('deposits.usdt.txid')}</dt>
          <dd className="flex flex-wrap items-center gap-2 font-medium">
            {usdt.txid ? (
              <>
                <ExplorerLink href={usdt.explorerUrl}>
                  <code dir="ltr" className="break-all">
                    {usdt.txid}
                  </code>
                </ExplorerLink>
                {usdt.txidSource && (
                  <Badge tone="neutral">{t(`deposits.usdt.txidSources.${usdt.txidSource}`)}</Badge>
                )}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <Fact label={t('deposits.usdt.submissions')}>{usdt.txidSubmissions}</Fact>
        <Fact label={t('deposits.usdt.lastChecked')}>
          {usdt.lastCheckedAt ? formatDateTime(usdt.lastCheckedAt) : '—'}
        </Fact>
        {usdt.checkError && (
          <Fact label={t('deposits.usdt.checkError')}>
            {t(`deposits.usdt.checkErrors.${usdt.checkError}`)}
          </Fact>
        )}
        {usdt.checkStatus === 'confirming' && (
          <Fact label={t('deposits.usdt.confirmations')}>
            {usdt.confirmations ?? 0} / {usdt.requiredConfirmations}
          </Fact>
        )}
        {deposit.status === 'pending' && (
          <Fact label={t('deposits.detail.expires')}>{formatDateTime(deposit.expiresAt)}</Fact>
        )}
        {usdt.delayed && (
          <Fact label={t('deposits.usdt.scanner')}>
            <Badge tone="warning">{t('deposits.usdt.delayed')}</Badge>
          </Fact>
        )}
      </dl>
    </Card>
  );
}

/** The bound transfer: from, to, the received amount with its difference, block and time. */
export function UsdtTransferCard({ usdt }: { usdt: AdminDepositUsdt }) {
  const { t } = useTranslation();
  const transfer = usdt.transfer;
  return (
    <Card className="gap-3">
      <CardTitle>{t('deposits.usdt.transfer')}</CardTitle>
      {!transfer ? (
        <p className="text-sm text-muted-foreground">{t('deposits.usdt.noTransfer')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Fact label={t('deposits.usdt.received')}>
            <span className="flex flex-col gap-1">
              {usdtText(transfer.amountUnits)}
              <Difference received={transfer.amountUnits} asked={usdt.payAmountUnits} />
            </span>
          </Fact>
          <Fact label={t('deposits.usdt.transferNetwork')}>
            {t(`wallets.methods.${transfer.method}`)}
          </Fact>
          <Address label={t('deposits.usdt.from')} value={transfer.fromAddress} />
          <Address label={t('deposits.usdt.to')} value={transfer.toAddress} />
          <Fact label={t('deposits.usdt.block')}>
            <ExplorerLink href={transfer.explorerUrl}>
              <bdi dir="ltr">{transfer.blockNumber}</bdi>
            </ExplorerLink>
          </Fact>
          <Fact label={t('deposits.usdt.blockTime')}>{formatDateTime(transfer.blockTime)}</Fact>
        </dl>
      )}
    </Card>
  );
}

/** The received amount against the amount to pay; highlighted when they differ. */
function Difference({ received, asked }: { received: number; asked: number }) {
  const { t } = useTranslation();
  if (received === asked) {
    return <Badge tone="success">{t('deposits.usdt.exact')}</Badge>;
  }
  const less = received < asked;
  return (
    <Badge tone="warning">
      {t(less ? 'deposits.usdt.less' : 'deposits.usdt.more', {
        amount: usdtText(Math.abs(received - asked)),
      })}
    </Badge>
  );
}

function Address({ label, value }: { label: string; value: string }) {
  return (
    <div className="col-span-2 flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium break-all" dir="ltr">
        <code>{value}</code>
      </dd>
    </div>
  );
}

export function ExplorerLink({ href, children }: { href: string | null; children: ReactNode }) {
  const { t } = useTranslation();
  if (!href) return children;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={t('deposits.usdt.explorer')}
      className="inline-flex items-center gap-1 rounded-sm underline underline-offset-4"
    >
      {children}
      <ExternalLinkIcon className="size-4 shrink-0" aria-hidden="true" />
    </a>
  );
}

/**
 * Rule U11: reserved USDT deposits of any customer with the same amount or tail, so a transfer
 * that belongs to someone else is visible.
 */
export function CandidateList({ candidates }: { candidates: UsdtCandidate[] }) {
  const { t } = useTranslation();
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('deposits.usdt.noCandidates')}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {candidates.map((candidate) => (
        <li
          key={candidate.depositId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border p-3 text-sm"
        >
          <Link
            to="/deposits/$id"
            params={{ id: candidate.depositId }}
            className="rounded-sm font-medium underline underline-offset-4"
          >
            <bdi dir="ltr">{candidate.referenceCode}</bdi>
          </Link>
          <Badge tone={STATUS_TONES[candidate.status]}>
            {t(`deposits.statuses.${candidate.status}`)}
          </Badge>
          <span className="tabular-nums">{usdtText(candidate.payAmountUnits)}</span>
          <span>{candidate.customer.name}</span>
          <span dir="ltr" className="text-muted-foreground">
            {candidate.customer.email}
          </span>
          <span className="text-muted-foreground">{formatDateTime(candidate.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The approval of a review (rule U15): the credit is the received amount floored to whole cents,
 * shown live and never typed; every flag ticked; re-authentication always, and the retry keeps
 * the `Idempotency-Key`.
 */
export function UsdtApproveForm({
  deposit,
  usdt,
}: {
  deposit: AdminDeposit;
  usdt: AdminDepositUsdt;
}) {
  const { t } = useTranslation();
  const approve = useApproveUsdtDeposit(deposit.id);
  const keyFor = useIdempotencyKey();
  const [ticked, setTicked] = useState<DepositFlagCode[]>([]);
  const [note, setNote] = useState('');
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const flags = [...new Set(deposit.flags.map((flag) => flag.code))];
  const credit = usdt.transfer ? floorToWholeCents(usdt.transfer.amountUnits) : 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    if (flags.some((code) => !ticked.includes(code))) {
      return setFlagsError(t('deposits.approve.errors.flags'));
    }
    setFlagsError(null);
    const body: ApproveUsdtDeposit = {
      acknowledgedFlags: ticked.filter((code) => flags.includes(code)),
      internalNote: note.trim() || undefined,
    };
    const parsed = approveUsdtDepositSchema.parse(body);
    try {
      await approve.mutateAsync({ body: parsed, key: keyFor(parsed) });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'FLAGS_NOT_ACKNOWLEDGED') {
        setFlagsError(errorMessage(t, error));
      } else {
        setFailure(errorMessage(t, error));
      }
    }
  }

  return (
    <Card className="gap-4">
      <CardTitle>{t('deposits.approve.title')}</CardTitle>
      <p className="flex items-start gap-2 rounded-md bg-status-info p-3 text-sm text-status-info-foreground">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t('deposits.usdt.approveVerify')}
      </p>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <dl className="flex flex-col gap-1 rounded-lg border border-border p-3">
          <dt className="text-sm text-muted-foreground">{t('deposits.approve.credit')}</dt>
          <dd className="text-2xl font-bold tabular-nums">
            <bdi dir="ltr">{formatUsd(credit)}</bdi>
          </dd>
          <dd className="text-sm text-muted-foreground">{t('deposits.usdt.creditHint')}</dd>
        </dl>
        {flags.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('deposits.approve.flags')}</legend>
            {flags.map((code) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control.
              <label key={code} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={ticked.includes(code)}
                  onCheckedChange={(checked) =>
                    setTicked((previous) =>
                      checked ? [...previous, code] : previous.filter((item) => item !== code),
                    )
                  }
                />
                <span>
                  <span className="font-medium">{t(`deposits.flags.${code}.label`)}</span>
                  {' — '}
                  {t(`deposits.flags.${code}.description`)}
                </span>
              </label>
            ))}
            {flagsError && (
              <p role="alert" className="text-sm text-destructive-text">
                {flagsError}
              </p>
            )}
          </fieldset>
        )}
        <Field>
          <FieldLabel>{t('deposits.approve.note')}</FieldLabel>
          <Textarea
            name="internalNote"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldDescription>{t('deposits.approve.noteHint')}</FieldDescription>
        </Field>
        <p className="text-sm text-muted-foreground">{t('deposits.usdt.reauthentication')}</p>
        {failure && <FormAlert>{failure}</FormAlert>}
        <Button type="submit" className="self-start" disabled={approve.isPending || credit === 0}>
          {approve.isPending
            ? t('deposits.approve.submitting')
            : t('deposits.approve.submit', { amount: ltr(formatUsd(credit)) })}
        </Button>
      </form>
    </Card>
  );
}
