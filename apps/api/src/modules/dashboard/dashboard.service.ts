import { Injectable } from '@nestjs/common';
import {
  type AttentionItem,
  type AttentionKind,
  compared,
  type Dashboard,
  damascusDayBounds,
  isRateStale,
  marginPercent,
  WORKER_SILENT_MINUTES,
} from '@vertex-digital/contracts';
import { DepositReviewService } from '../deposits/index.js';
import { HealthService } from '../health/index.js';
import { MerchantsAdminService } from '../merchants/index.js';
import { OrderActionsService } from '../orders/index.js';
import { PricingService } from '../pricing/index.js';
import { RatesService } from '../rates/index.js';
import { ReconciliationService } from '../reconciliation/index.js';
import { SettingsService } from '../settings/index.js';
import { SuppliersService } from '../suppliers/index.js';
import { SupportAdminService } from '../support/index.js';
import { TelegramService } from '../telegram/index.js';

type Item = Omit<AttentionItem, 'oldestAt' | 'params' | 'orders'> &
  Partial<Pick<AttentionItem, 'params' | 'orders'>> & { oldestAt?: Date | null };

/**
 * The panel's home page (S11 rules DB1–DB9): one read made of the owning modules' own reads, in
 * parallel, never cached; it writes nothing and owns no table. Money and order counts cover real
 * customers; the live counts and the attention list include test orders (rule DB1).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly orders: OrderActionsService,
    private readonly deposits: DepositReviewService,
    private readonly suppliers: SuppliersService,
    private readonly pricing: PricingService,
    private readonly rates: RatesService,
    private readonly settings: SettingsService,
    private readonly telegram: TelegramService,
    private readonly support: SupportAdminService,
    private readonly reconciliation: ReconciliationService,
    private readonly merchants: MerchantsAdminService,
    private readonly health: HealthService,
  ) {}

  async dashboard(now = new Date()): Promise<Dashboard> {
    const bounds = damascusDayBounds(now);
    const [
      orders,
      deposits,
      suppliers,
      failing,
      reviews,
      rate,
      switches,
      telegram,
      tickets,
      books,
      applications,
      lastBeat,
    ] = await Promise.all([
      this.orders.figures(bounds, now),
      this.deposits.dashboardFigures(now, bounds.todayStart),
      this.suppliers.list(),
      this.suppliers.failingSyncs(),
      this.pricing.reviews({ status: 'open', page: 1, pageSize: 1 }),
      this.rates.current(),
      this.settings.adminSwitches(),
      this.telegram.status(),
      this.support.waiting(),
      this.reconciliation.attention(now),
      this.merchants.waiting(),
      this.health.lastWorkerBeat(),
    ]);
    const { today, yesterday, live } = orders;
    const profit = (period: typeof today) => period.salesUsdUnits - period.costUsdUnits;
    const rateStale = isRateStale(rate?.createdAt ?? null, now);

    // Rule DB6, in its order; an item at zero is left out.
    const workerSilent =
      lastBeat !== null && now.getTime() - lastBeat.getTime() > WORKER_SILENT_MINUTES * 60_000;
    const items: Item[] = [
      // Audit A10-53: a stopped worker stops deposits, deliveries and emails; null is a store
      // whose worker never ran yet.
      ...(workerSilent
        ? [{ kind: 'worker_silent' as const, count: 1, oldestAt: lastBeat, target: '/' }]
        : []),
      { kind: 'orders_review', count: live.review, target: '/orders/live' },
      { kind: 'orders_manual', count: live.manual, target: '/orders/live' },
      {
        kind: 'deposits_overdue',
        count: deposits.overdue,
        oldestAt: deposits.overdueSince,
        target: '/deposits',
      },
      {
        kind: 'deposits_flagged',
        count: deposits.deposits.shamCashFlagged,
        target: '/deposits',
      },
      {
        kind: 'usdt_unmatched',
        count: deposits.deposits.unmatchedTransfers,
        target: '/deposits/transfers',
      },
      // S13: the books.
      { kind: 'reconciliation_open', count: books.open, target: '/reconciliation' },
      ...(books.missing
        ? [
            {
              kind: 'reconciliation_missing' as const,
              count: 1,
              oldestAt: books.missing.lastFinishedAt,
              target: '/reconciliation',
            },
          ]
        : []),
      ...(books.countDue
        ? [{ kind: 'sham_cash_count_due' as const, count: 1, target: '/reconciliation' }]
        : []),
      ...supplierItems(suppliers, failing),
      { kind: 'price_reviews', count: reviews.total, target: '/pricing/reviews' },
      ...(rateStale ? [{ kind: 'rate_stale' as const, count: 1, target: '/rates' }] : []),
      ...switches.switches
        // Each stop or pause that is on; registration open is the normal state.
        .filter((item) => item.switch !== 'registration_open' && item.value)
        .map((item) => ({
          kind: 'switches_active' as const,
          count: 1,
          oldestAt: item.since ? new Date(item.since) : null,
          target: '/settings/switches',
          params: { switch: item.switch },
        })),
      {
        kind: 'order_conflicts',
        count: orders.conflicts.count,
        oldestAt: orders.conflicts.newestAt,
        target: '/orders',
        orders: orders.conflicts.orders,
      },
      // S12 TK13: tickets waiting for the admin, with the oldest customer message.
      {
        kind: 'tickets_waiting',
        count: tickets.count,
        oldestAt: tickets.oldestAt,
        target: '/support',
      },
      // S20 MA8: merchant applications under review, with the oldest submission.
      {
        kind: 'merchant_applications_waiting',
        count: applications.count,
        oldestAt: applications.oldestAt,
        target: '/merchants/applications',
      },
      ...(telegram.link === null
        ? [{ kind: 'telegram_unlinked' as const, count: 1, target: '/settings/telegram' }]
        : []),
    ];

    return {
      generatedAt: now.toISOString(),
      sales: compared(today.salesUsdUnits, yesterday.salesUsdUnits),
      profit: compared(profit(today), profit(yesterday)),
      marginPercent: marginPercent(profit(today), today.salesUsdUnits),
      delivered: compared(today.delivered, yesterday.delivered),
      refunds: compared(today.refunds, yesterday.refunds),
      refundedUsd: compared(today.refundedUsdUnits, yesterday.refundedUsdUnits),
      medianDeliveryMs: orders.medianDeliveryMs,
      salesLine: orders.salesLine,
      now: {
        atSupplier: live.at_supplier,
        manual: live.manual,
        review: live.review,
        finished: live.finished,
        awaitingBalance: live.awaitingBalance,
        openValueUsdUnits: orders.openValueUsdUnits,
      },
      deposits: deposits.deposits,
      suppliers: suppliers.map((supplier) => ({
        code: supplier.code,
        nameAr: supplier.nameAr,
        available: supplier.available,
        health: supplier.health,
        healthSince: supplier.healthSince,
        paused: supplier.paused,
        balanceUsdUnits:
          supplier.code !== 'manual' && supplier.balance?.currency === 'USD'
            ? supplier.balance.amountUnits
            : null,
        balanceAt: supplier.code !== 'manual' ? (supplier.balance?.createdAt ?? null) : null,
        lowBalanceUsdUnits: supplier.lowBalanceUsdUnits,
        balanceLow: supplier.balanceLow,
        lastSync: supplier.lastRun
          ? { status: supplier.lastRun.status, at: supplier.lastRun.startedAt }
          : null,
      })),
      rate: rate
        ? { sypPerUsd: rate.sypPerUsd, setAt: rate.createdAt.toISOString(), stale: rateStale }
        : null,
      attention: items
        .filter((item) => item.count > 0)
        .map((item) => ({
          kind: item.kind,
          count: item.count,
          oldestAt: item.oldestAt?.toISOString() ?? null,
          target: item.target,
          params: item.params ?? {},
          orders: item.orders ?? [],
        })),
    };
  }
}

/** Rule DB6: each supplier's alerts, with the definitions of its Telegram alerts. */
function supplierItems(
  suppliers: Awaited<ReturnType<SuppliersService['list']>>,
  failing: ReadonlySet<string>,
): Item[] {
  return suppliers.flatMap((supplier) => {
    const item = (kind: AttentionKind, oldestAt: string | null = null): Item => ({
      kind,
      count: 1,
      oldestAt: oldestAt ? new Date(oldestAt) : null,
      target: `/suppliers/${supplier.code}`,
      params: { supplier: supplier.code, nameAr: supplier.nameAr },
    });
    return [
      ...(supplier.health === 'down' ? [item('supplier_down', supplier.healthSince)] : []),
      ...(supplier.health === 'degraded' ? [item('supplier_degraded', supplier.healthSince)] : []),
      ...(supplier.balanceLow ? [item('supplier_balance_low')] : []),
      ...(failing.has(supplier.code) ? [item('supplier_sync_failing')] : []),
      ...(supplier.canValidatePlayer &&
      supplier.validationQuota > 0 &&
      supplier.validationsToday >= supplier.validationQuota
        ? [item('validation_quota_reached')]
        : []),
    ];
  });
}
