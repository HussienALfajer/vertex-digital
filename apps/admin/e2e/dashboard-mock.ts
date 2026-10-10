import { compared, type Dashboard, marginPercent } from '@vertex-digital/contracts';

/*
 * The panel's home page (S11, F18) as `GET /api/admin/dashboard` answers it: a quiet day by
 * default (no sales, nothing needs the admin), and a busy one for the screenshots and the
 * attention list's links.
 */

const USD = 1_000_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const day = (offset: number) => {
  const date = new Date(Date.now() - offset * 86_400_000);
  return date.toISOString().slice(0, 10);
};

const suppliers: Dashboard['suppliers'] = [
  {
    code: 'shop2topup',
    nameAr: 'SHOP2TOPUP',
    health: 'healthy',
    healthSince: ago(600),
    paused: false,
    balanceUsdUnits: 412 * USD,
    balanceAt: ago(3),
    lowBalanceUsdUnits: 100 * USD,
    balanceLow: false,
    lastSync: { status: 'succeeded', at: ago(12) },
  },
  {
    code: 'wdgzone',
    nameAr: 'WDGZone',
    health: 'healthy',
    healthSince: ago(900),
    paused: false,
    balanceUsdUnits: 230 * USD,
    balanceAt: ago(5),
    lowBalanceUsdUnits: 100 * USD,
    balanceLow: false,
    lastSync: { status: 'succeeded', at: ago(14) },
  },
  {
    code: 'manual',
    nameAr: 'يدوي',
    health: 'healthy',
    healthSince: null,
    paused: false,
    balanceUsdUnits: null,
    balanceAt: null,
    lowBalanceUsdUnits: 0,
    balanceLow: false,
    lastSync: null,
  },
];

/** A quiet day: rule DB6's list is empty and the money is zero. */
export function quietDashboard(rate: { sypPerUsd: string; createdAt: string } | null): Dashboard {
  return {
    generatedAt: new Date().toISOString(),
    sales: compared(0, 0),
    profit: compared(0, 0),
    marginPercent: null,
    delivered: compared(0, 0),
    refunds: compared(0, 0),
    refundedUsd: compared(0, 0),
    medianDeliveryMs: null,
    salesLine: Array.from({ length: 7 }, (_, index) => ({
      date: day(6 - index),
      salesUsdUnits: 0,
    })),
    now: {
      atSupplier: 0,
      manual: 0,
      review: 0,
      finished: 0,
      awaitingBalance: 0,
      openValueUsdUnits: 0,
    },
    deposits: {
      shamCashWaiting: 0,
      shamCashOldestAt: null,
      shamCashFlagged: 0,
      usdtWaiting: 0,
      unmatchedTransfers: 0,
      creditedToday: [
        { method: 'sham_cash', count: 0, usdUnits: 0 },
        { method: 'usdt_trc20', count: 0, usdUnits: 0 },
        { method: 'usdt_bep20', count: 0, usdUnits: 0 },
      ],
    },
    suppliers,
    rate: rate ? { sypPerUsd: rate.sypPerUsd, setAt: rate.createdAt, stale: false } : null,
    attention: [],
  };
}

/** A busy afternoon: sales above yesterday, held and manual orders, a paused supplier. */
export function busyDashboard(): Dashboard {
  const sales = 1_284_500_000;
  const profit = 96_300_000;
  return {
    ...quietDashboard({ sypPerUsd: '118', createdAt: ago(60) }),
    sales: compared(sales, 1_102_000_000),
    profit: compared(profit, 101_000_000),
    marginPercent: marginPercent(profit, sales),
    delivered: compared(143, 121),
    refunds: compared(3, 0),
    refundedUsd: compared(29_700_000, 0),
    medianDeliveryMs: 41_000,
    salesLine: [980, 1_120, 860, 1_430, 1_210, 1_102, 1_284.5].map((dollars, index) => ({
      date: day(6 - index),
      salesUsdUnits: Math.round(dollars * USD),
    })),
    now: {
      atSupplier: 4,
      manual: 1,
      review: 1,
      finished: 18,
      awaitingBalance: 2,
      openValueUsdUnits: 61_900_000,
    },
    deposits: {
      shamCashWaiting: 3,
      shamCashOldestAt: ago(22),
      shamCashFlagged: 1,
      usdtWaiting: 1,
      unmatchedTransfers: 1,
      creditedToday: [
        { method: 'sham_cash', count: 17, usdUnits: 845 * USD },
        { method: 'usdt_trc20', count: 4, usdUnits: 310 * USD },
        { method: 'usdt_bep20', count: 0, usdUnits: 0 },
      ],
    },
    suppliers: suppliers.map((supplier) =>
      supplier.code === 'wdgzone'
        ? {
            ...supplier,
            health: 'degraded',
            healthSince: ago(18),
            paused: true,
            balanceUsdUnits: 64 * USD,
            balanceLow: true,
            lastSync: { status: 'failed', at: ago(9) },
          }
        : supplier,
    ),
    attention: [
      {
        kind: 'orders_review',
        count: 1,
        oldestAt: null,
        target: '/orders/live',
        params: {},
        orders: [],
      },
      {
        kind: 'orders_manual',
        count: 1,
        oldestAt: null,
        target: '/orders/live',
        params: {},
        orders: [],
      },
      {
        kind: 'deposits_overdue',
        count: 1,
        oldestAt: ago(22),
        target: '/deposits',
        params: {},
        orders: [],
      },
      {
        kind: 'supplier_degraded',
        count: 1,
        oldestAt: ago(18),
        target: '/suppliers/wdgzone',
        params: { supplier: 'wdgzone', nameAr: 'WDGZone' },
        orders: [],
      },
      {
        kind: 'supplier_balance_low',
        count: 1,
        oldestAt: null,
        target: '/suppliers/wdgzone',
        params: { supplier: 'wdgzone', nameAr: 'WDGZone' },
        orders: [],
      },
      {
        kind: 'switches_active',
        count: 1,
        oldestAt: ago(40),
        target: '/settings/switches',
        params: { switch: 'wdgzone_paused' },
        orders: [],
      },
      {
        kind: 'order_conflicts',
        count: 1,
        oldestAt: ago(300),
        target: '/orders',
        params: {},
        orders: [{ id: '0199b000-0000-7000-8000-000000000001', number: 'VO-HELD23' }],
      },
    ],
  };
}
