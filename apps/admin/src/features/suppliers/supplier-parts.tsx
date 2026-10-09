import {
  formatSyp,
  formatUsd,
  type RouteUnusableReason,
  type SupplierBalance,
  type SupplierHealthState,
  type SupplierSummary,
  type SyncRun,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { formatSince } from '../../lib/format';

/*
 * What the supplier screens share: the state chips, a balance, a sync run's result and counts,
 * and why a route is unusable.
 */

const HEALTH_TONES = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
} as const satisfies Record<SupplierHealthState, string>;

/** "سليم", "متراجع" or "متوقف" (rules H1–H3). */
export function HealthBadge({ health }: { health: SupplierHealthState }) {
  const { t } = useTranslation();
  return <Badge tone={HEALTH_TONES[health]}>{t(`suppliers.health.${health}`)}</Badge>;
}

/** Available or not (rule SP1), configured, paused (rule SP3), and its health. */
export function SupplierChips({ supplier }: { supplier: SupplierSummary }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-2">
      {supplier.available ? (
        <Badge tone="success">{t('suppliers.chips.available')}</Badge>
      ) : (
        <Badge tone="warning">{t('suppliers.chips.unavailable')}</Badge>
      )}
      {!supplier.configured && <Badge tone="neutral">{t('suppliers.chips.notConfigured')}</Badge>}
      {supplier.paused && <Badge tone="warning">{t('suppliers.chips.paused')}</Badge>}
      {supplier.available && supplier.configured && <HealthBadge health={supplier.health} />}
    </span>
  );
}

/** A balance in the supplier's currency (A07). */
export function balanceText(balance: Pick<SupplierBalance, 'currency' | 'amountUnits'>): string {
  return balance.currency === 'USD'
    ? formatUsd(balance.amountUnits)
    : formatSyp(balance.amountUnits);
}

/** The newest balance, "تحت الحد" when below the threshold, and when it was read (rule H5). */
export function BalanceLine({ supplier }: { supplier: SupplierSummary }) {
  const { t } = useTranslation();
  if (!supplier.balance) {
    return <span className="text-sm text-muted-foreground">{t('suppliers.balance.none')}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <bdi dir="ltr" className="text-lg font-bold tabular-nums">
        {balanceText(supplier.balance)}
      </bdi>
      {supplier.balanceLow && <Badge tone="danger">{t('suppliers.balance.low')}</Badge>}
      <span className="text-xs text-muted-foreground">
        {t('suppliers.balance.readAt', { since: formatSince(supplier.balance.createdAt) })}
      </span>
    </span>
  );
}

const RUN_TONES = {
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
} as const satisfies Record<SyncRun['status'], string>;

export function RunStatusBadge({ status }: { status: SyncRun['status'] }) {
  const { t } = useTranslation();
  return <Badge tone={RUN_TONES[status]}>{t(`suppliers.runs.statuses.${status}`)}</Badge>;
}

/** The codes a failed run records (rules SY1–SY3), each with its text; others are the supplier's. */
const RUN_ERRORS = [
  'SUPPLIER_NOT_CONFIGURED',
  'SUPPLIER_UNAVAILABLE',
  'SUPPLIER_REFUSED',
  'SUPPLIER_ERROR',
  'CATALOG_SUSPICIOUS',
  'ABANDONED',
  'INTERNAL',
] as const;

type RunError = (typeof RUN_ERRORS)[number];

/** Why a run failed: its code's text, or the supplier's own code as it came. */
export function RunError({ code }: { code: string }) {
  const { t } = useTranslation();
  if ((RUN_ERRORS as readonly string[]).includes(code)) {
    return <span>{t(`suppliers.runs.errors.${code as RunError}`)}</span>;
  }
  return (
    <span>
      {t('suppliers.runs.errors.supplierCode')} <bdi dir="ltr">{code}</bdi>
    </span>
  );
}

/** A run's counts on one line: seen, new, cost changes, missing, reviews, repriced. */
export function RunCounts({ run }: { run: SyncRun }) {
  const { t } = useTranslation();
  return (
    <span className="text-sm text-muted-foreground tabular-nums">
      {t('suppliers.runs.counts', {
        seen: run.offersSeen,
        added: run.offersNew,
        changed: run.costsChanged,
        missing: run.offersMissing,
        reviews: run.reviewsOpened,
        repriced: run.productsRepriced,
      })}
    </span>
  );
}

/** The last run on a supplier's card: when, its result, and its counts or its error. */
export function LastRun({ run }: { run: SyncRun | null }) {
  const { t } = useTranslation();
  if (!run) {
    return <span className="text-sm text-muted-foreground">{t('suppliers.runs.never')}</span>;
  }
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={run.status} />
        <span className="text-sm text-muted-foreground">{formatSince(run.startedAt)}</span>
      </span>
      {run.status === 'failed' && run.errorCode ? (
        <span className="text-sm text-status-danger-foreground">
          <RunError code={run.errorCode} />
        </span>
      ) : (
        run.status === 'succeeded' && <RunCounts run={run} />
      )}
    </span>
  );
}

/** Rule RT4: why a route cannot serve its product now, in the admin's words. */
export function UnusableReason({ reason }: { reason: RouteUnusableReason }) {
  const { t } = useTranslation();
  return <Badge tone="warning">{t(`suppliers.routes.unusable.${reason}`)}</Badge>;
}
