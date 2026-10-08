'use client';

import { type Deposit, formatRate, formatSyp, formatUsd } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  HourglassIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { amountText, STATUS_TONES } from './amounts';
import { PendingDeposit } from './pending-deposit';
import { getDeposit } from './requests';

/** While in review the page reads the deposit again this often, when visible (S03 screens). */
const REFRESH_MS = 30_000;

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'ready'; deposit: Deposit };

/**
 * One deposit, by its status (S03 screens). Read in the browser with the session, never cached;
 * another customer's deposit is the 404 page.
 */
export function DepositPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    const result = await getDeposit(id);
    if (!result.ok && result.reason === 'UNAUTHORIZED') {
      router.replace(`/sign-in?next=${encodeURIComponent(`/wallet/deposits/${id}`)}`);
      return;
    }
    if (!result.ok) {
      return setState({ status: result.reason === 'NOT_FOUND' ? 'missing' : 'failed' });
    }
    setState({ status: 'ready', deposit: result.data });
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const inReview = state.status === 'ready' && state.deposit.status === 'submitted';
  useEffect(() => {
    if (!inReview) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [inReview, load]);

  if (state.status === 'missing') notFound();
  if (state.status === 'loading') return <DepositSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('deposits.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('deposits.retry')}
          </Button>
        }
      />
    );
  }

  const { deposit } = state;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* A pending deposit shows its code large, in the step that uses it. */}
        {deposit.status !== 'pending' && (
          <p className="text-sm text-muted-foreground">
            {t('deposits.detail.reference')}{' '}
            <bdi dir="ltr" className="font-medium text-foreground">
              {deposit.referenceCode}
            </bdi>
          </p>
        )}
        <Badge tone={STATUS_TONES[deposit.status]}>
          {t(`deposits.statuses.${deposit.status}`)}
        </Badge>
      </div>
      {deposit.status === 'pending' ? (
        <PendingDeposit
          key={deposit.id}
          deposit={deposit}
          onChange={(next) => {
            if (next) setState({ status: 'ready', deposit: next });
            else void load();
          }}
        />
      ) : (
        <Outcome deposit={deposit} />
      )}
    </div>
  );
}

/** Every status after the receipt: in review, credited, rejected, expired or cancelled. */
function Outcome({ deposit }: { deposit: Deposit }) {
  const declared = (
    <Line label={t('deposits.detail.amount')}>
      {amountText(deposit.currency, deposit.declaredAmountUnits)}
    </Line>
  );
  switch (deposit.status) {
    case 'submitted':
      return (
        <Panel icon={HourglassIcon} tone="muted" title={t('deposits.detail.submittedTitle')}>
          <p className="flex items-start gap-2 text-base">
            <ClockIcon className="mt-1 size-4 shrink-0" aria-hidden="true" />
            {!deposit.eta
              ? t('deposits.eta.unknown')
              : deposit.eta.state === 'closed'
                ? t('deposits.eta.closed', { date: formatDateTime(deposit.eta.opensAt) })
                : t('deposits.eta.open', { minutes: deposit.eta.minutes })}
          </p>
          <dl className="flex flex-col gap-2">{declared}</dl>
          <p className="text-sm text-muted-foreground">{t('deposits.detail.submittedBody')}</p>
        </Panel>
      );
    case 'credited': {
      const credited = deposit.credited;
      return (
        <Panel icon={CircleCheckIcon} tone="success" title={t('deposits.detail.creditedTitle')}>
          {credited && (
            <p className="text-3xl font-bold text-status-success-foreground tabular-nums">
              <bdi dir="ltr">{formatUsd(credited.usdUnits)}</bdi>
            </p>
          )}
          <dl className="flex flex-col gap-2">
            {credited?.receivedCurrency === 'SYP' && credited.rate && (
              <Line label={t('deposits.detail.received')}>
                {t('deposits.sypAtRate', {
                  amount: formatSyp(credited.receivedAmountUnits),
                  rate: formatRate(credited.rate),
                })}
              </Line>
            )}
            {deposit.decidedAt && (
              <Line label={t('deposits.detail.creditedAt')}>
                {formatDateTime(deposit.decidedAt)}
              </Line>
            )}
          </dl>
          <Button size="xl" render={<Link href="/wallet" />}>
            {t('deposits.backToWallet')}
          </Button>
        </Panel>
      );
    }
    case 'rejected':
      return (
        <Panel icon={CircleXIcon} tone="muted" title={t('deposits.detail.rejectedTitle')}>
          {deposit.rejection && (
            <p className="text-base font-medium">
              {t(`deposits.rejectReasons.${deposit.rejection.reason}`)}
            </p>
          )}
          {deposit.rejection?.note && (
            <p className="text-base break-words text-muted-foreground">{deposit.rejection.note}</p>
          )}
          <dl className="flex flex-col gap-2">{declared}</dl>
          <NewDepositButton />
        </Panel>
      );
    default:
      return (
        <Panel
          icon={CircleXIcon}
          tone="muted"
          title={t(
            deposit.status === 'expired'
              ? 'deposits.detail.expiredTitle'
              : 'deposits.detail.cancelledTitle',
          )}
        >
          <p className="text-base text-muted-foreground">
            {t(
              deposit.status === 'expired'
                ? 'deposits.detail.expiredBody'
                : 'deposits.detail.cancelledBody',
            )}
          </p>
          <NewDepositButton />
        </Panel>
      );
  }
}

function NewDepositButton() {
  return (
    <Button size="xl" render={<Link href="/wallet/deposit" />}>
      {t('deposits.newDeposit')}
    </Button>
  );
}

function Panel({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon;
  tone: 'muted' | 'success';
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4">
      <div className="flex items-center gap-3">
        <IconTile tone={tone}>
          <Icon />
        </IconTile>
        <h2 className="text-xl font-bold">{title}</h2>
      </div>
      {children}
    </Card>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function DepositSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-6 w-40" />
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-36 w-full" />
      ))}
    </div>
  );
}
