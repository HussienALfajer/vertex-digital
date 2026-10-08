import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type AdminDeposit, formatRate, formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { ArrowRightIcon, ImageUpIcon, XCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { auditListQuery } from '../audit/audit.queries';
import { actorLabel } from '../audit/audit-labels';
import { ApproveForm } from './approve-form';
import { CustomerPanel } from './customer-panel';
import { RejectDialog, RequestReceiptDialog } from './decision-dialogs';
import { DepositFlags } from './deposit-flags';
import { depositAmount, STATUS_TONES } from './deposit-labels';
import { depositQuery } from './deposits.queries';
import { Fact } from './fact';
import { ReceiptViewer } from './receipt-viewer';

/**
 * One deposit (S03 screens): the receipt, the facts, the flags and the customer, and while it is
 * in review the approval, the rejection and the clearer-receipt request (rules RV1–RV9). A
 * decided deposit shows its decision and audit trail, read-only.
 */
export function DepositPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const deposit = useQuery(depositQuery(id));
  const [dialog, setDialog] = useState<'reject' | 'request' | null>(null);

  const back = (
    <Button variant="ghost" className="self-start" render={<Link to="/deposits" />}>
      <ArrowRightIcon className="rtl:-scale-x-100" />
      {t('deposits.detail.back')}
    </Button>
  );

  if (deposit.isPending) {
    return (
      <>
        {back}
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-9 w-64" />
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        </div>
      </>
    );
  }
  if (deposit.isError) {
    return (
      <>
        {back}
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, deposit.error)}</FormAlert>
          <Button variant="outline" onClick={() => deposit.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </>
    );
  }

  const data = deposit.data;
  const inReview = data.status === 'submitted';
  return (
    <>
      {back}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi dir="ltr">{data.referenceCode}</bdi>
            <Badge tone={STATUS_TONES[data.status]}>{t(`deposits.statuses.${data.status}`)}</Badge>
          </span>
        }
        description={t('deposits.detail.subtitle', {
          amount: depositAmount(t, data.currency, data.declaredAmountUnits),
        })}
        actions={
          inReview && (
            <>
              {data.receiptRequestCount === 0 && (
                <Button variant="outline" onClick={() => setDialog('request')}>
                  <ImageUpIcon />
                  {t('deposits.requestReceipt.open')}
                </Button>
              )}
              <Button variant="outline" onClick={() => setDialog('reject')}>
                <XCircleIcon />
                {t('deposits.reject.open')}
              </Button>
            </>
          )
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <ReceiptViewer deposit={data} />
          <Facts deposit={data} />
        </div>
        <div className="flex flex-col gap-6">
          <Card className="gap-3">
            <CardTitle>{t('deposits.detail.flags')}</CardTitle>
            <DepositFlags flags={data.flags} />
          </Card>
          <CustomerPanel deposit={data} />
          {inReview && <ApproveForm key={data.id} deposit={data} onDone={() => undefined} />}
          {(data.credit || data.rejection) && <Decision deposit={data} />}
        </div>
      </div>
      <AuditTrail id={data.id} />

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === 'reject' && <RejectDialog deposit={data} onDone={() => setDialog(null)} />}
        {dialog === 'request' && (
          <RequestReceiptDialog deposit={data} onDone={() => setDialog(null)} />
        )}
      </Dialog>
    </>
  );
}

function Facts({ deposit }: { deposit: AdminDeposit }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('deposits.detail.facts')}</CardTitle>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Fact label={t('deposits.detail.declared')}>
          {depositAmount(t, deposit.currency, deposit.declaredAmountUnits)}
        </Fact>
        <Fact label={t('deposits.detail.declaredUsd')}>
          <bdi dir="ltr">{formatUsd(deposit.declaredUsdUnits)}</bdi>
        </Fact>
        {deposit.quote && (
          <>
            <Fact label={t('deposits.detail.rate')}>{formatRate(deposit.quote.rate)}</Fact>
            <Fact label={t('deposits.detail.rateState')}>
              {deposit.rateFixedAt
                ? t('deposits.detail.rateFixed', { date: formatDateTime(deposit.rateFixedAt) })
                : t('deposits.detail.rateLocked', {
                    date: formatDateTime(deposit.quote.expiresAt),
                  })}
            </Fact>
          </>
        )}
        <Fact label={t('deposits.detail.created')}>{formatDateTime(deposit.createdAt)}</Fact>
        <Fact label={t('deposits.detail.submitted')}>
          {deposit.submittedAt ? formatDateTime(deposit.submittedAt) : '—'}
        </Fact>
        {deposit.status === 'pending' && (
          <Fact label={t('deposits.detail.expires')}>{formatDateTime(deposit.expiresAt)}</Fact>
        )}
        {deposit.receiptRequestedAt && (
          <Fact label={t('deposits.detail.receiptRequested')}>
            {formatDateTime(deposit.receiptRequestedAt)}
            {deposit.receiptRequestNote && (
              <span className="block font-normal text-muted-foreground">
                {deposit.receiptRequestNote}
              </span>
            )}
          </Fact>
        )}
        {deposit.eta && (
          <Fact label={t('deposits.detail.eta')}>
            {deposit.eta.state === 'open'
              ? t('deposits.detail.etaOpen', { minutes: deposit.eta.minutes })
              : t('deposits.detail.etaClosed', { date: formatDateTime(deposit.eta.opensAt) })}
          </Fact>
        )}
      </dl>
    </Card>
  );
}

/** The decision, read-only: the credit with its journal, or the rejection. */
function Decision({ deposit }: { deposit: AdminDeposit }) {
  const { t } = useTranslation();
  const { credit, rejection } = deposit;
  return (
    <Card className="gap-3">
      <CardTitle>{t('deposits.detail.decision')}</CardTitle>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        {credit && (
          <>
            <Fact label={t('deposits.detail.credited')}>
              <bdi dir="ltr" className="text-status-success-foreground">
                {formatUsd(credit.creditedUsdUnits)}
              </bdi>
            </Fact>
            <Fact label={t('deposits.detail.received')}>
              {depositAmount(t, credit.receivedCurrency, credit.receivedAmountUnits)}
            </Fact>
            {credit.creditRate && (
              <Fact label={t('deposits.detail.creditRate')}>{formatRate(credit.creditRate)}</Fact>
            )}
            <Fact label={t('deposits.detail.transaction')}>
              <code dir="ltr">{credit.transactionNumber}</code>
            </Fact>
            <Fact label={t('deposits.detail.referenceCheck')}>
              {t(`deposits.referenceChecks.${credit.referenceCheck}`)}
            </Fact>
            <Fact label={t('deposits.detail.journal')}>
              <code dir="ltr" title={credit.journalId}>
                {credit.journalId.slice(0, 8)}
              </code>
            </Fact>
          </>
        )}
        {rejection && (
          <>
            <Fact label={t('deposits.detail.rejectReason')}>
              {t(`deposits.rejectReasons.${rejection.reason}`)}
            </Fact>
            <Fact label={t('deposits.detail.customerNote')}>{rejection.customerNote ?? '—'}</Fact>
          </>
        )}
        <Fact label={t('deposits.detail.decidedBy')}>
          {deposit.adminName ?? t('common.unknown')}
        </Fact>
        <Fact label={t('deposits.detail.decidedAt')}>
          {deposit.decidedAt ? formatDateTime(deposit.decidedAt) : '—'}
        </Fact>
      </dl>
    </Card>
  );
}

/** The deposit's audit entries, from the audit log filtered by the deposit. */
function AuditTrail({ id }: { id: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(auditListQuery({ entityType: 'deposit', entityId: id }));
  const entries = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="flex flex-col gap-3" aria-labelledby="deposit-audit">
      <h2 id="deposit-audit" className="text-lg font-bold">
        {t('deposits.detail.audit')}
      </h2>
      {list.isPending && <Skeleton className="h-24 w-full" aria-hidden="true" />}
      {list.isError && <FormAlert>{errorMessage(t, list.error)}</FormAlert>}
      {list.isSuccess && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('deposits.detail.noAudit')}</p>
      )}
      {entries.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('audit.columns.time')}</TableHead>
              <TableHead>{t('audit.columns.action')}</TableHead>
              <TableHead>{t('audit.columns.actor')}</TableHead>
              <TableHead>{t('audit.detail.reason')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(entry.occurredAt)}
                </TableCell>
                <TableCell>{t(`audit.actions.${entry.action}`)}</TableCell>
                <TableCell>{actorLabel(t, entry)}</TableCell>
                <TableCell className="min-w-44 whitespace-normal">{entry.reason ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
        </Button>
      )}
    </section>
  );
}
