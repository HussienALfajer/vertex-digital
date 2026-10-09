import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type AdminOrder, type FulfilmentAttempt, formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { ArrowRightIcon, CircleAlertIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../../components/copy-button';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, ltr } from '../../lib/format';
import { DecisionDialog, type OrderDecision } from './decision-dialogs';
import { ATTEMPT_TONES, playerCheckText, STATUS_TONES } from './order-labels';
import { orderQuery, useRevealCode } from './orders.queries';

/** A revealed code is hidden again after this long (rule C3). */
const REVEAL_MS = 30_000;

/**
 * One order (S08 screens): the header, the decision panel when rule D1 allows one, the account
 * fields, the attempts newest first with their candidates and webhook events, the events, the
 * journals, and the codes masked with their reveal log.
 */
export function OrderPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const order = useQuery(orderQuery(id));
  const [decision, setDecision] = useState<OrderDecision | null>(null);

  return (
    <>
      <PageHeader
        title={order.data ? <bdi dir="ltr">{order.data.number}</bdi> : t('orders.detail.title')}
        description={
          order.data ? `${order.data.product.nameAr} · ${order.data.game.nameAr}` : undefined
        }
        actions={
          <Button variant="ghost" render={<Link to="/orders" />}>
            <ArrowRightIcon className="ltr:-scale-x-100" />
            {t('orders.back')}
          </Button>
        }
      />
      {order.isPending && <Skeleton className="h-96 w-full" aria-hidden="true" />}
      {order.isError && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, order.error)}
          action={
            <Button variant="outline" onClick={() => order.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {order.isSuccess && (
        <div className="flex flex-col gap-6">
          <Header order={order.data} />
          <Decisions order={order.data} onDecide={setDecision} />
          <Fields order={order.data} />
          {order.data.codes.length > 0 && <Codes order={order.data} />}
          <Attempts attempts={order.data.attempts} />
          <Events order={order.data} />
          <Journals order={order.data} />
          <Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
            {decision && (
              <DecisionDialog
                order={order.data}
                decision={decision}
                onDone={() => setDecision(null)}
              />
            )}
          </Dialog>
        </div>
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function Header({ order }: { order: AdminOrder }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONES[order.status]}>{t(`orders.statuses.${order.status}`)}</Badge>
        {order.customer.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
        {order.refundReason && (
          <Badge tone="neutral">{t(`orders.refundReasons.${order.refundReason}`)}</Badge>
        )}
        {order.cancelReason && (
          <Badge tone="neutral">{t(`orders.cancelReasons.${order.cancelReason}`)}</Badge>
        )}
      </div>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label={t('orders.detail.customer')}>
          <Link
            to="/wallets/$customerId"
            params={{ customerId: order.customer.id }}
            className="underline-offset-4 hover:underline"
          >
            {order.customer.name}
          </Link>
          <span dir="ltr" className="block text-end text-sm font-normal text-muted-foreground">
            {order.customer.email}
          </span>
        </Fact>
        <Fact label={t('orders.detail.total')}>
          <bdi dir="ltr">{formatUsd(order.totalUsdUnits)}</bdi>
          <span className="block text-sm font-normal text-muted-foreground">
            {t('orders.detail.unitPrice', { price: ltr(formatUsd(order.unitPriceUsdUnits)) })}
          </span>
        </Fact>
        <Fact label={t('orders.detail.units')}>
          {t('orders.detail.unitsValue', {
            quantity: order.quantity,
            delivered: order.deliveredQuantity,
            refunded: order.refundedQuantity,
          })}
        </Fact>
        <Fact label={t('orders.detail.refunded')}>
          <bdi dir="ltr">{formatUsd(order.refundedUsdUnits)}</bdi>
        </Fact>
        <Fact label={t('orders.detail.paidAt')}>
          {order.paidAt ? formatDateTime(order.paidAt) : '—'}
        </Fact>
        <Fact label={t('orders.detail.finishedAt')}>
          {order.finishedAt ? formatDateTime(order.finishedAt) : '—'}
        </Fact>
        {order.reviewSince && (
          <Fact label={t('orders.detail.reviewSince')}>{formatDateTime(order.reviewSince)}</Fact>
        )}
        <Fact label={t('orders.detail.minMargin')}>
          <bdi dir="ltr">{formatUsd(order.minMarginUsdUnits)}</bdi>
        </Fact>
        {order.reservedAt && (
          <Fact label={t('orders.detail.reservedAt')}>{formatDateTime(order.reservedAt)}</Fact>
        )}
        {order.expiresAt && (
          <Fact label={t('orders.detail.expiresAt')}>{formatDateTime(order.expiresAt)}</Fact>
        )}
        {order.cancelReason && (
          <Fact label={t('orders.detail.cancelReason')}>
            {t(`orders.cancelReasons.${order.cancelReason}`)}
          </Fact>
        )}
        <Fact label={t('orders.detail.playerCheck')}>
          <bdi>{playerCheckText(t, order)}</bdi>
        </Fact>
      </dl>
    </Card>
  );
}

/** Rule D1: only the decisions the order allows now. */
function Decisions({
  order,
  onDecide,
}: {
  order: AdminOrder;
  onDecide: (decision: OrderDecision) => void;
}) {
  const { t } = useTranslation();
  const { decisions } = order;
  if (!decisions.poll && !decisions.resolve && !decisions.refund) return null;
  return (
    <Card className="gap-4 border-status-warning">
      <div className="flex flex-col gap-1">
        <CardTitle>{t('orders.decisions.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {order.status === 'needs_review'
            ? t('orders.decisions.heldHelp')
            : t('orders.decisions.manualHelp')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {decisions.poll && (
          <Button variant="outline" onClick={() => onDecide('poll')}>
            {t('orders.decisions.poll.open')}
          </Button>
        )}
        {decisions.resolve && (
          <>
            <Button onClick={() => onDecide('delivered')}>
              {t('orders.decisions.delivered.open')}
            </Button>
            <Button variant="outline" onClick={() => onDecide('failed')}>
              {t('orders.decisions.failed.open')}
            </Button>
          </>
        )}
        {decisions.refund && (
          <Button variant="destructive" onClick={() => onDecide('refund')}>
            {t('orders.decisions.refund.open')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function Fields({ order }: { order: AdminOrder }) {
  const { t } = useTranslation();
  if (order.fields.length === 0) return null;
  return (
    <Card className="gap-3">
      <CardTitle>{t('orders.detail.fields')}</CardTitle>
      <dl className="grid gap-4 sm:grid-cols-2">
        {order.fields.map((field) => (
          <Fact key={field.key} label={field.labelAr}>
            <span className="flex items-center gap-2">
              <bdi dir="ltr">{field.value || '—'}</bdi>
              {field.value && (
                <CopyButton
                  value={field.value}
                  label={t('orders.detail.copyField', { field: field.labelAr })}
                />
              )}
            </span>
          </Fact>
        ))}
      </dl>
    </Card>
  );
}

/** Rule C3: masked; "كشف" re-authenticates, logs the reveal, and hides it after 30 seconds. */
function Codes({ order }: { order: AdminOrder }) {
  const { t } = useTranslation();
  const reveal = useRevealCode(order.id);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  // One timer per code: each is hidden 30 seconds after its own reveal.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const hide = useCallback((codeId: string) => {
    clearTimeout(timers.current.get(codeId));
    timers.current.delete(codeId);
    setShown(({ [codeId]: _hidden, ...rest }) => rest);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  async function show(codeId: string) {
    setFailure(null);
    try {
      const { code } = await reveal.mutateAsync(codeId);
      // The value lives only in this card's state, never in the query client (rule C1).
      reveal.reset();
      setShown((previous) => ({ ...previous, [codeId]: code }));
      clearTimeout(timers.current.get(codeId));
      timers.current.set(
        codeId,
        setTimeout(() => hide(codeId), REVEAL_MS),
      );
    } catch (error) {
      reveal.reset();
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="gap-3">
      <CardTitle>{t('orders.codes.title')}</CardTitle>
      <ul className="flex flex-col gap-3">
        {order.codes.map((code) => {
          const value = shown[code.id];
          return (
            <li key={code.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium tabular-nums" dir="ltr">
                  {code.position}. {value ?? code.masked}
                </span>
                {value ? (
                  <span className="flex gap-2">
                    <CopyButton value={value} label={t('orders.codes.copy')} />
                    <Button variant="outline" size="sm" onClick={() => hide(code.id)}>
                      <EyeOffIcon />
                      {t('orders.codes.hide')}
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reveal.isPending}
                    onClick={() => void show(code.id)}
                  >
                    <EyeIcon />
                    {t('orders.codes.reveal')}
                  </Button>
                )}
              </div>
              {code.reveals.length > 0 && (
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {code.reveals.map((item) => (
                    <li key={`${item.createdAt}:${item.actor}`}>
                      {t(`orders.codes.revealedBy.${item.actor}`, {
                        date: formatDateTime(item.createdAt),
                      })}
                      {item.ipAddress && (
                        <>
                          {' · '}
                          <bdi dir="ltr">{item.ipAddress}</bdi>
                        </>
                      )}
                      {item.userAgent && <> · {item.userAgent}</>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {failure && <FormAlert>{failure}</FormAlert>}
    </Card>
  );
}

function Attempts({ attempts }: { attempts: FulfilmentAttempt[] }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3" aria-labelledby="order-attempts">
      <h2 id="order-attempts" className="text-lg font-bold">
        {t('orders.attempts.title')}
      </h2>
      {attempts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('orders.attempts.none')}</p>
      )}
      {attempts.map((attempt) => (
        <Card key={attempt.id} className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-medium">
              {attempt.supplierNameAr}
              <Badge tone={ATTEMPT_TONES[attempt.status]}>
                {t(`orders.attempts.statuses.${attempt.status}`)}
              </Badge>
              {attempt.inputRejected && (
                <Badge tone="danger">{t('orders.attempts.inputRejected')}</Badge>
              )}
            </span>
            <span className="text-sm text-muted-foreground">
              {attempt.sentAt ? formatDateTime(attempt.sentAt) : formatDateTime(attempt.createdAt)}
            </span>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Fact label={t('orders.attempts.offer')}>
              {attempt.offerName}{' '}
              <bdi dir="ltr" className="text-muted-foreground">
                {attempt.offerId}
              </bdi>
            </Fact>
            <Fact label={t('orders.attempts.units')}>
              {t('orders.attempts.unitsValue', {
                quantity: attempt.quantity,
                delivered: attempt.deliveredQuantity,
              })}
            </Fact>
            <Fact label={t('orders.attempts.unitCost')}>
              <bdi dir="ltr">{formatUsd(attempt.unitCostUsdUnits)}</bdi>
            </Fact>
            <Fact label={t('orders.attempts.key')}>
              <bdi dir="ltr" className="text-xs break-all">
                {attempt.id}
              </bdi>
            </Fact>
            <Fact label={t('orders.attempts.supplierRef')}>
              <bdi dir="ltr" className="break-all">
                {attempt.supplierOrderId ?? '—'}
              </bdi>
            </Fact>
            <Fact label={t('orders.attempts.resolvedBy')}>
              {attempt.resolvedBy ? t(`orders.attempts.resolvers.${attempt.resolvedBy}`) : '—'}
              {attempt.resolvedAt && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {formatDateTime(attempt.resolvedAt)}
                </span>
              )}
            </Fact>
            <Fact label={t('orders.attempts.polls')}>
              {attempt.pollCount}
              {attempt.nextPollAt && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {t('orders.attempts.nextPoll', { date: formatDateTime(attempt.nextPollAt) })}
                </span>
              )}
            </Fact>
            {(attempt.failureReason || attempt.supplierErrorCode) && (
              <Fact label={t('orders.attempts.failure')}>
                <bdi dir="ltr" className="break-words">
                  {[attempt.supplierErrorCode, attempt.failureReason].filter(Boolean).join(' · ')}
                </bdi>
              </Fact>
            )}
            {attempt.adminReason && (
              <Fact label={t('orders.attempts.adminReason')}>{attempt.adminReason}</Fact>
            )}
          </dl>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">{t('orders.attempts.candidates')}</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('orders.attempts.candidate.supplier')}</TableHead>
                  <TableHead>{t('orders.attempts.candidate.tier')}</TableHead>
                  <TableHead>{t('orders.attempts.candidate.cost')}</TableHead>
                  <TableHead>{t('orders.attempts.candidate.result')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempt.candidates.map((candidate) => (
                  <TableRow key={candidate.routeId}>
                    <TableCell>{t(`orders.suppliers.${candidate.supplierCode}`)}</TableCell>
                    <TableCell>
                      {candidate.tier ? t(`orders.attempts.tiers.${candidate.tier}`) : '—'}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {candidate.costUsdUnits === null ? (
                        '—'
                      ) : (
                        <bdi dir="ltr">{formatUsd(candidate.costUsdUnits)}</bdi>
                      )}
                    </TableCell>
                    <TableCell>
                      {candidate.rank !== null ? (
                        <Badge tone={candidate.rank === 1 ? 'success' : 'neutral'}>
                          {t('orders.attempts.candidate.rank', { rank: candidate.rank })}
                        </Badge>
                      ) : (
                        t(`orders.skipReasons.${candidate.skipReason ?? 'archived'}`)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {attempt.webhookEvents.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-bold">{t('orders.attempts.webhooks')}</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {attempt.webhookEvents.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-center gap-2">
                    <bdi dir="ltr" className="text-xs">
                      {event.eventId}
                    </bdi>
                    {event.result && (
                      <Badge tone={event.result === 'conflict' ? 'danger' : 'neutral'}>
                        {t(`orders.webhookResults.${event.result}`)}
                      </Badge>
                    )}
                    <span className="text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ))}
    </section>
  );
}

function Events({ order }: { order: AdminOrder }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('orders.events.title')}</CardTitle>
      <ol className="flex flex-col gap-2">
        {order.events.map((event) => (
          <li
            key={event.id}
            className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
          >
            <span>
              {event.kind === 'status' && event.toStatus
                ? t('orders.events.status', {
                    to: t(`orders.statuses.${event.toStatus}`),
                  })
                : event.kind === 'attempt'
                  ? t('orders.events.attempt', {
                      status: t(
                        `orders.attempts.statuses.${(event.details.status as FulfilmentAttempt['status']) ?? 'pending'}`,
                      ),
                    })
                  : t('orders.events.note')}
              {' · '}
              <span className="text-muted-foreground">
                {t(`orders.events.actors.${event.actor}`)}
              </span>
              {event.reason && (
                <>
                  {' · '}
                  <bdi dir="ltr" className="text-muted-foreground">
                    {event.reason}
                  </bdi>
                </>
              )}
            </span>
            <span className="text-muted-foreground">{formatDateTime(event.createdAt)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Journals({ order }: { order: AdminOrder }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('orders.journals.title')}</CardTitle>
      <ul className="flex flex-col gap-2">
        {order.journals.map((journal) => (
          <li key={journal.id} className="flex items-center justify-between gap-2 text-sm">
            <span>{t(`orders.journals.kinds.${journal.kind}`)}</span>
            <span className="flex items-center gap-3">
              <bdi dir="ltr" className="font-medium tabular-nums">
                {formatUsd(journal.amountUsdUnits)}
              </bdi>
              <span className="text-muted-foreground">{formatDateTime(journal.createdAt)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
