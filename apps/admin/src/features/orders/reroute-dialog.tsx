import { useQuery } from '@tanstack/react-query';
import { type AdminOrder, formatUsd, rerouteOrderSchema } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@vertex-digital/ui';
import { RouteOffIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatSince } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { rerouteOptionsQuery, useRerouteOrder } from './orders.queries';

const HEALTH_TONES = { healthy: 'success', degraded: 'warning', down: 'danger' } as const;

/**
 * S11 rules RR1–RR4: the product's routes with their eligibility for this order (eligible ones
 * selectable, the others greyed with their reason), the warning on a held order, a reason,
 * re-authentication and the dialog's `Idempotency-Key`. A route that stopped being eligible
 * since the list was read (edge case 2) answers `ROUTE_NOT_ELIGIBLE`: the list is read again.
 */
export function RerouteDialog({ order, onDone }: { order: AdminOrder; onDone: () => void }) {
  const { t } = useTranslation();
  const options = useQuery(rerouteOptionsQuery(order.id));
  const reroute = useRerouteOrder(order.id);
  const keyFor = useIdempotencyKey();
  const [routeId, setRouteId] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ route?: boolean; reason?: boolean }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const eligible = options.data?.routes.filter((route) => route.eligible) ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
    const parsed = rerouteOrderSchema.safeParse({ routeId, reason });
    const paths = new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0]));
    setErrors({ route: paths.has('routeId'), reason: paths.has('reason') });
    if (!parsed.success) return;
    try {
      await reroute.mutateAsync({ body: parsed.data, key: keyFor(parsed.data) });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
      if (error instanceof ApiError && error.code === 'ROUTE_NOT_ELIGIBLE') {
        setRouteId(null);
        void options.refetch();
      }
    }
  }

  return (
    <DialogContent
      closeLabel={t('common.close')}
      className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
    >
      <DialogHeader>
        <DialogTitle>{t('orders.reroute.title')}</DialogTitle>
        <DialogDescription>
          {t('orders.reroute.description', { number: order.number })}
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {options.isPending && <Skeleton className="h-40 w-full" aria-hidden="true" />}
        {options.isError && <FormAlert>{errorMessage(t, options.error)}</FormAlert>}
        {options.isSuccess && eligible.length === 0 && (
          <Callout
            tone="info"
            icon={<RouteOffIcon />}
            title={t('orders.reroute.none')}
            description={t('orders.reroute.noneHelp')}
          />
        )}
        {options.isSuccess && options.data.routes.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">
              {t('orders.reroute.routes', { units: options.data.remainingUnits })}
            </legend>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">{t('orders.reroute.choose')}</span>
                  </TableHead>
                  <TableHead>{t('orders.reroute.supplier')}</TableHead>
                  <TableHead>{t('orders.reroute.offer')}</TableHead>
                  <TableHead>{t('orders.reroute.cost')}</TableHead>
                  <TableHead>{t('orders.reroute.margin')}</TableHead>
                  <TableHead>{t('orders.reroute.balance')}</TableHead>
                  <TableHead>{t('orders.reroute.state')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {options.data.routes.map((route) => (
                  <TableRow
                    key={route.routeId}
                    data-state={routeId === route.routeId ? 'selected' : undefined}
                    className={route.eligible ? undefined : 'text-muted-foreground'}
                  >
                    <TableCell>
                      <input
                        type="radio"
                        name="route"
                        className="size-4 accent-primary"
                        value={route.routeId}
                        disabled={!route.eligible}
                        checked={routeId === route.routeId}
                        onChange={() => setRouteId(route.routeId)}
                        aria-label={t('orders.reroute.chooseRoute', {
                          supplier: route.supplierNameAr,
                          offer: route.offerName,
                        })}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        {route.supplierNameAr}
                        {route.supplierCode !== 'manual' && (
                          <Badge tone={HEALTH_TONES[route.health]}>
                            {t(`suppliers.health.${route.health}`)}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      {route.offerName}
                      {route.tier && (
                        <span className="block text-xs text-muted-foreground">
                          {t(`orders.attempts.tiers.${route.tier}`)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {route.unitCostUsdUnits === null ? (
                        '—'
                      ) : (
                        <bdi dir="ltr">{formatUsd(route.unitCostUsdUnits)}</bdi>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {route.marginUsdUnits === null ? (
                        '—'
                      ) : (
                        <bdi
                          dir="ltr"
                          className={route.marginUsdUnits < 0 ? 'text-destructive-text' : undefined}
                        >
                          {formatUsd(route.marginUsdUnits)}
                        </bdi>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {route.balanceUsdUnits === null ? (
                        '—'
                      ) : (
                        <>
                          <bdi dir="ltr">{formatUsd(route.balanceUsdUnits)}</bdi>
                          {route.balanceAt && (
                            <span className="block text-xs text-muted-foreground">
                              {formatSince(route.balanceAt)}
                            </span>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      {route.eligible ? (
                        <Badge tone="success">{t('orders.reroute.eligible')}</Badge>
                      ) : (
                        t(`orders.skipReasons.${route.skipReason ?? 'archived'}`)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <FieldError match={!!errors.route}>{t('orders.reroute.routeError')}</FieldError>
          </fieldset>
        )}
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('orders.decisions.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={!!errors.reason}>{t('orders.decisions.reasonError')}</FieldError>
        </Field>
        {order.status === 'needs_review' && (
          <Callout
            tone="warning"
            icon={<TriangleAlertIcon />}
            title={t('orders.reroute.warning')}
          />
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={reroute.isPending || eligible.length === 0}>
            {reroute.isPending ? t('orders.decisions.submitting') : t('orders.reroute.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
