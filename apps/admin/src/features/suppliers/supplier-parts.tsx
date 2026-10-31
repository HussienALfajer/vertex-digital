import { useQuery } from '@tanstack/react-query';
import {
  formatSyp,
  formatUsd,
  PLAN_EXPIRY_ALERT_HOURS,
  type RouteUnusableReason,
  type SupplierBalance,
  type SupplierCode,
  type SupplierHealthState,
  type SupplierSummary,
  type SyncRun,
} from '@vertex-digital/contracts';
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatSince } from '../../lib/format';
import { platformStatusQuery } from './suppliers.queries';

/*
 * What the supplier screens share: the state chips, a balance, a sync run's result and counts,
 * and why a route is unusable.
 */

const HEALTH_TONES = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
} as const satisfies Record<SupplierHealthState, string>;

/** "سليم", "متراجع" or "متوقف" (rules H1–H3), with what the state means as its tooltip. */
export function HealthBadge({ health }: { health: SupplierHealthState }) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge tone={HEALTH_TONES[health]} tabIndex={0} />}
        aria-label={`${t(`suppliers.health.${health}`)}: ${t(`suppliers.healthMeaning.${health}`)}`}
      >
        {t(`suppliers.health.${health}`)}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{t(`suppliers.healthMeaning.${health}`)}</TooltipContent>
    </Tooltip>
  );
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

/**
 * S19 FC9: the supplier's plan and its end as the worker's last read said: "غير فعّال" while
 * inactive (no orders, no checks), "ينتهي قريباً" within 48 hours of its end.
 */
export function SubscriptionLine({ supplier }: { supplier: SupplierSummary }) {
  const { t } = useTranslation();
  const plan = supplier.subscription;
  if (!plan) {
    return (
      <span className="text-sm text-muted-foreground">{t('suppliers.subscription.none')}</span>
    );
  }
  const endsSoon =
    plan.active &&
    plan.expiresAt !== null &&
    new Date(plan.expiresAt).getTime() - Date.now() <= PLAN_EXPIRY_ALERT_HOURS * 3_600_000;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <bdi dir="ltr" className="text-lg font-bold">
        {plan.plan}
      </bdi>
      {!plan.active ? (
        <Badge tone="danger">{t('suppliers.subscription.inactive')}</Badge>
      ) : (
        endsSoon && <Badge tone="warning">{t('suppliers.subscription.endsSoon')}</Badge>
      )}
      {plan.expiresAt && (
        <span className="text-xs text-muted-foreground">
          {t('suppliers.subscription.until', { time: formatDateTime(plan.expiresAt) })}
        </span>
      )}
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
  'INTERRUPTED',
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

/**
 * Rule SF5: the supplier's own status and catalog update time, read by the API when the panel
 * asks (cached a minute); its text is the supplier's, shown as text.
 */
export function PlatformStatusLine({ code }: { code: SupplierCode }) {
  const { t } = useTranslation();
  const status = useQuery(platformStatusQuery(code));
  if (status.isPending) {
    return <span className="text-sm text-muted-foreground">{t('suppliers.platform.reading')}</span>;
  }
  if (status.isError) {
    return <span className="text-sm text-muted-foreground">{t('suppliers.platform.failed')}</span>;
  }
  return <PlatformStatusView status={status.data} />;
}

/** S18: the supplier's words for its state in Arabic; any other shows as received. */
const PLATFORM_STATES = ['operational', 'maintenance', 'degraded', 'down'] as const;

/**
 * The supplier's own status and when its catalog last changed; S18 PS1: the cards show the one
 * the list carries (the sync's or the panel's last read) and never call the supplier.
 */
export function PlatformStatusView({
  status,
}: {
  status: { status: string; catalogUpdatedAt: string | null };
}) {
  const { t } = useTranslation();
  const known = PLATFORM_STATES.find((state) => state === status.status.toLowerCase());
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t('suppliers.platform.label')}</span>
      <Badge tone={known === 'operational' ? 'success' : 'outline'}>
        <bdi>{known ? t(`suppliers.platform.states.${known}`) : status.status}</bdi>
      </Badge>
      {status.catalogUpdatedAt && (
        <span className="text-muted-foreground" title={formatDateTime(status.catalogUpdatedAt)}>
          {t('suppliers.platform.catalogUpdated', {
            since: formatSince(status.catalogUpdatedAt),
          })}
        </span>
      )}
    </span>
  );
}
