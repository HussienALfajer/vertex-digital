import {
  type AdminOrder,
  type AdminShop,
  approveShopSchema,
  type MerchantShopOrderRow,
  SHOP_DEFAULT_LIMITS,
  type ShopAction,
  type ShopCustomerRow,
  settleShopCustomerSchema,
  shopCompensationAmounts,
  shopCompensationRefusal,
  shopCompensationRequestSchema,
  shopReasonSchema,
  shopTransition,
  suspendShopSchema,
  updateShopSchema,
} from '@vertex-digital/contracts';
import type { Answer } from './catalog-mock';

/*
 * The admin's merchant shops (S26 PR 4) as the panel sees them: a request, an active shop and a
 * closed one with balances, moved on the contracts' `shopTransition`; limits, slug and the
 * announcement (SH3, SH8, ST5), a customer's freeze (CA7), a closed shop's settlement with its
 * `Idempotency-Key` replayed (WL9), and a shop order's compensation on the order page (PR10).
 */

type Body = Record<string, unknown> | null;
type ShopCustomer = ShopCustomerRow & { frozenReason: string | null };

const USD = 1_000_000;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
export const shopId = (n: number) => `0199e600-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

function shop(n: number, fields: Partial<AdminShop>): AdminShop {
  return {
    id: shopId(n),
    slug: `shop-${n}`,
    status: 'active',
    displayName: `متجر ${n}`,
    brandColor: '#1f7a6c',
    announcement: null,
    rateMode: 'store',
    ownRate: null,
    rate: '118',
    limits: { ...SHOP_DEFAULT_LIMITS },
    transferredTodayUsdUnits: 0,
    customerCount: 0,
    rejectReason: null,
    suspendReason: null,
    requestedAt: at(60 * 24 * 10),
    decidedAt: at(60 * 24 * 9),
    requestAgainAt: null,
    merchantId: shopId(100 + n),
    merchantName: 'عمر الحلبي',
    suspendNote: null,
    closedAt: null,
    totalBalanceUsdUnits: 0,
    heldMarginUsdUnits: 0,
    openOrders: 0,
    settled: false,
    oldSlugs: [],
    rates: [],
    ...fields,
  };
}

function customer(n: number, fields: Partial<ShopCustomer>): ShopCustomer {
  return {
    id: shopId(200 + n),
    name: `زبون ${n}`,
    email: `customer${n}@example.com`,
    phone: '+963944123456',
    state: 'active',
    origin: 'merchant',
    balanceUsdUnits: 0,
    pendingReturn: null,
    createdAt: at(60 * 24 * 3),
    frozenReason: null,
    ...fields,
  };
}

export class ShopsMock {
  shops: AdminShop[] = [
    shop(1, {
      slug: 'abu-omar',
      displayName: 'محل أبو عمر',
      status: 'requested',
      brandColor: '#2563eb',
      rateMode: 'own',
      ownRate: '120',
      rate: '120',
      decidedAt: null,
      requestedAt: at(90),
      rates: [{ rate: '120', confirmedFar: false, createdAt: at(90) }],
    }),
    shop(2, {
      slug: 'noor',
      displayName: 'محل النور',
      announcement: 'خصم 5% على شدات ببجي هذا الأسبوع',
      customerCount: 2,
      totalBalanceUsdUnits: 35 * USD,
      heldMarginUsdUnits: 400_000,
      openOrders: 1,
      transferredTodayUsdUnits: 50 * USD,
      oldSlugs: ['alnoor'],
    }),
    shop(3, {
      slug: 'sham',
      displayName: 'متجر الشام',
      status: 'closed',
      merchantName: 'سامر الخطيب',
      customerCount: 1,
      totalBalanceUsdUnits: 12 * USD,
      closedAt: at(60 * 5),
    }),
  ];
  customers = new Map<string, ShopCustomer[]>([
    [
      shopId(2),
      [
        customer(1, { name: 'سامي علي', balanceUsdUnits: 20 * USD }),
        customer(2, { name: 'ليلى حسن', balanceUsdUnits: 15 * USD, origin: 'self' }),
      ],
    ],
    [shopId(3), [customer(3, { name: 'رامي يوسف', balanceUsdUnits: 12 * USD })]],
  ]);
  orders = new Map<string, MerchantShopOrderRow[]>([
    [
      shopId(2),
      [
        {
          id: '0199b000-0000-7000-8000-000000000003',
          number: 'VO-DONE67',
          stage: 'delivered',
          customer: { id: shopId(201), name: 'سامي علي' },
          productNameAr: 'بطاقة آيتونز 10$',
          gameNameAr: 'آيتونز',
          quantity: 1,
          deliveredQuantity: 1,
          totalSellUsdUnits: 1_200_000,
          marginUsdUnits: 210_000,
          marginState: 'released',
          createdAt: at(46),
        },
      ],
    ],
  ]);
  /** The settlements and compensations already answered, by their key (replays). */
  private readonly keys = new Map<string, unknown>();

  constructor(
    private readonly reauthenticationRequired: () => boolean,
    private readonly order: (id: string) => AdminOrder | undefined,
  ) {}

  answer(method: string, url: URL, body: Body, idempotencyKey: string | null): Answer | null {
    const path = url.pathname;
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;

    const compensation = path.match(/^\/api\/admin\/orders\/([^/]+)\/shop-compensation$/);
    if (compensation && method === 'POST') {
      return sensitive() ?? this.compensate(compensation[1] as string, body, idempotencyKey);
    }
    if (path === '/api/admin/shops' && method === 'GET') {
      const status = url.searchParams.get('status');
      const q = url.searchParams.get('q');
      const rows = this.shops
        .filter((row) => !status || row.status === status)
        .filter((row) => !q || row.slug.includes(q) || row.displayName.includes(q))
        .map((row) => ({
          id: row.id,
          merchantId: row.merchantId,
          merchantName: row.merchantName,
          tradeName: row.displayName,
          slug: row.slug,
          status: row.status,
          brandColor: row.brandColor,
          customerCount: row.customerCount,
          totalBalanceUsdUnits: row.totalBalanceUsdUnits,
          heldMarginUsdUnits: row.heldMarginUsdUnits,
          transferredTodayUsdUnits: row.transferredTodayUsdUnits,
          requestedAt: row.requestedAt,
        }));
      return { status: 200, json: { items: rows, nextCursor: null } };
    }
    const freeze = path.match(/^\/api\/admin\/shop-customers\/([^/]+)\/(freeze|unfreeze)$/);
    if (freeze && method === 'POST') {
      const parsed = shopReasonSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const row = [...this.customers.values()].flat().find((item) => item.id === freeze[1]);
      if (!row) return error(404, 'NOT_FOUND');
      const frozen = freeze[2] === 'freeze';
      row.state = frozen ? 'frozen' : 'active';
      row.frozenReason = frozen ? parsed.data.reason : null;
      return { status: 200, json: row };
    }
    const one = path.match(/^\/api\/admin\/shops\/([^/]+)(?:\/(.+))?$/);
    if (!one) return null;
    const target = this.shops.find((row) => row.id === one[1]);
    if (!target) return error(404, 'NOT_FOUND');
    const rest = one[2];
    if (method === 'GET' && !rest) return { status: 200, json: target };
    if (method === 'GET' && rest === 'customers') {
      const q = url.searchParams.get('q');
      const rows = (this.customers.get(target.id) ?? []).filter(
        (row) => !q || row.name.includes(q) || row.email.includes(q),
      );
      return { status: 200, json: { items: rows, nextCursor: null } };
    }
    if (method === 'GET' && rest === 'orders') {
      return { status: 200, json: { items: this.orders.get(target.id) ?? [], nextCursor: null } };
    }
    if (method === 'PATCH' && !rest) {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = updateShopSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      if (parsed.data.slug && this.shops.some((row) => row.slug === parsed.data.slug)) {
        return error(409, 'SLUG_TAKEN');
      }
      if (parsed.data.limits) target.limits = parsed.data.limits;
      if (parsed.data.slug) {
        target.oldSlugs = [...target.oldSlugs, target.slug];
        target.slug = parsed.data.slug;
      }
      if (parsed.data.clearAnnouncement) target.announcement = null;
      return { status: 200, json: target };
    }
    const settle = rest?.match(/^customers\/([^/]+)\/settle$/);
    if (settle && method === 'POST') {
      const refused = sensitive();
      if (refused) return refused;
      if (idempotencyKey && this.keys.has(idempotencyKey)) {
        return { status: 200, json: this.keys.get(idempotencyKey) };
      }
      const parsed = settleShopCustomerSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      if (target.status !== 'closed') return error(409, 'SHOP_STATE_INVALID');
      const row = this.customers.get(target.id)?.find((item) => item.id === settle[1]);
      if (!row) return error(404, 'NOT_FOUND');
      const result = {
        shopCustomerId: row.id,
        to: parsed.data.to,
        amountUsdUnits: row.balanceUsdUnits,
        journalId: shopId(900),
      };
      target.totalBalanceUsdUnits -= row.balanceUsdUnits;
      row.balanceUsdUnits = 0;
      target.settled = target.totalBalanceUsdUnits === 0 && target.openOrders === 0;
      if (idempotencyKey) this.keys.set(idempotencyKey, result);
      return { status: 201, json: result };
    }
    const action = rest as ShopAction | undefined;
    if (
      method === 'POST' &&
      action &&
      ['approve', 'reject', 'suspend', 'resume', 'close'].includes(action)
    ) {
      if (action === 'close') {
        const refused = sensitive();
        if (refused) return refused;
      }
      const next = shopTransition(target.status, action);
      if (!next) return error(409, 'SHOP_STATE_INVALID');
      if (action === 'approve') {
        const parsed = approveShopSchema.safeParse(body);
        if (!parsed.success) return error(400, 'VALIDATION_FAILED');
        if (parsed.data.slug && this.shops.some((row) => row.slug === parsed.data.slug)) {
          return error(409, 'SLUG_TAKEN');
        }
        target.limits = parsed.data.limits;
        if (parsed.data.slug) target.slug = parsed.data.slug;
        target.decidedAt = new Date().toISOString();
      } else if (action === 'suspend') {
        const parsed = suspendShopSchema.safeParse(body);
        if (!parsed.success) return error(400, 'VALIDATION_FAILED');
        target.suspendReason = parsed.data.reason;
        target.suspendNote = parsed.data.note;
      } else if (action === 'reject' || action === 'close') {
        const parsed = shopReasonSchema.safeParse(body);
        if (!parsed.success) return error(400, 'VALIDATION_FAILED');
        if (action === 'reject') target.rejectReason = parsed.data.reason;
        else target.closedAt = new Date().toISOString();
      } else {
        target.suspendReason = null;
        target.suspendNote = null;
      }
      target.status = next;
      return { status: 200, json: target };
    }
    return null;
  }

  /** PR10: the order page's compensation, on the contracts' refusal and amounts. */
  private compensate(orderId: string, body: Body, idempotencyKey: string | null): Answer {
    if (idempotencyKey && this.keys.has(idempotencyKey)) {
      return { status: 200, json: this.keys.get(idempotencyKey) };
    }
    const parsed = shopCompensationRequestSchema.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED');
    const order = this.order(orderId);
    const sale = order?.shopSale;
    if (!order || !sale) return error(409, 'ORDER_NOT_COMPENSABLE');
    const refusal = shopCompensationRefusal(
      {
        shopOrder: true,
        finishedAt: order.finishedAt ? new Date(order.finishedAt) : null,
        deliveredQuantity: order.deliveredQuantity,
        compensatedQuantity: sale.compensatedQuantity,
      },
      parsed.data.units,
      new Date(),
    );
    if (refusal) return error(409, 'ORDER_NOT_COMPENSABLE', { reason: refusal });
    const released = (sale.marginReleasedUsdUnits ?? 0) > 0;
    const amounts = shopCompensationAmounts(
      sale.unitSellUsdUnits,
      order.unitPriceUsdUnits,
      parsed.data.units,
      released,
    );
    sale.compensatedQuantity += parsed.data.units;
    const result = {
      id: shopId(950),
      orderId,
      units: parsed.data.units,
      ...amounts,
      marginFrom: amounts.marginUsdUnits === 0 ? 'none' : parsed.data.marginFrom,
      createdAt: new Date().toISOString(),
    };
    if (idempotencyKey) this.keys.set(idempotencyKey, result);
    return { status: 201, json: result };
  }
}
