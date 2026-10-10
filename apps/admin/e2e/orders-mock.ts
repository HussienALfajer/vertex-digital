import {
  ADMIN_ORDER_TAB_STATUSES,
  type AdminOrder,
  type AdminOrderSummary,
  type AdminOrderTab,
  ORDER_POLICY_DEFAULTS,
  type OrderPolicy,
  orderDecisions,
  orderPolicySchema,
  refundOrderSchema,
  resolveAttemptSchema,
  revokeShareLinkSchema,
} from '@vertex-digital/contracts';
import type { Answer } from './catalog-mock';

/*
 * The orders API of S08 as the panel sees it: four orders (held for review, a manual one
 * waiting, delivered, refunded), the counts, the decisions with re-authentication and their
 * `Idempotency-Key` replays (rules D1–D5), code reveals (C3) and the policy. A decision changes
 * the order as the write path would, on the contracts' rules (`orderDecisions`).
 */

type Body = Record<string, unknown> | null;

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const id = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const ORDER_IDS = { held: id(1), manual: id(2), delivered: id(3), refunded: id(4) };

const customer = { id: id(90), name: 'سارة', email: 'sara@example.com', isTest: false };
const testCustomer = { id: id(91), name: 'تجربة', email: 'test@example.com', isTest: true };
const pubg = { id: id(80), nameAr: 'ببجي موبايل' };
const itunes = { id: id(81), nameAr: 'آيتونز' };

function attempt(
  n: number,
  supplier: { code: 'wdgzone' | 'manual' | 'fake'; nameAr: string },
  status: AdminOrder['attempts'][number]['status'],
  extra: Partial<AdminOrder['attempts'][number]> = {},
): AdminOrder['attempts'][number] {
  return {
    id: id(100 + n),
    routeId: id(200 + n),
    supplierCode: supplier.code,
    supplierNameAr: supplier.nameAr,
    offerId: `${supplier.code}-offer`,
    offerName: 'UC 60',
    quantity: 1,
    deliveredQuantity: status === 'delivered' ? 1 : 0,
    unitCostUsdUnits: 880_000,
    status,
    supplierOrderId: status === 'pending' ? null : `S-${n}`,
    failureReason: status === 'unknown' ? 'Supplier timed out' : null,
    inputRejected: false,
    supplierErrorCode: null,
    candidates: [
      {
        routeId: id(200 + n),
        supplierCode: supplier.code,
        tier: supplier.code === 'manual' ? 'manual' : 'healthy',
        costUsdUnits: 880_000,
        rank: 1,
        skipReason: null,
      },
      {
        routeId: id(300 + n),
        supplierCode: 'shop2topup',
        tier: null,
        costUsdUnits: 900_000,
        rank: null,
        skipReason: 'supplier_unavailable',
      },
    ],
    resolvedBy: status === 'delivered' ? 'supplier' : null,
    adminReason: null,
    pollCount: status === 'unknown' ? 12 : 0,
    sentAt: at(45),
    nextPollAt: status === 'unknown' ? at(-20) : null,
    resolvedAt: status === 'delivered' ? at(44) : null,
    createdAt: at(45),
    webhookEvents: [],
    ...extra,
  };
}

function order(n: keyof typeof ORDER_IDS, number: string, fields: Partial<AdminOrder>): AdminOrder {
  const base: AdminOrder = {
    id: ORDER_IDS[n],
    number,
    status: 'paid',
    customer,
    product: { id: id(70), nameAr: '60 UC', kind: 'direct' },
    game: pubg,
    fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب', value: '5123456789' }],
    quantity: 1,
    deliveredQuantity: 0,
    refundedQuantity: 0,
    unitPriceUsdUnits: 990_000,
    totalUsdUnits: 990_000,
    totalSypUnits: 1_287_000,
    minMarginUsdUnits: 50_000,
    refundedUsdUnits: 0,
    refundReason: null,
    reservedAt: null,
    expiresAt: null,
    cancelReason: null,
    playerCheck: 'none',
    playerName: null,
    paidAt: at(46),
    deliveredAt: null,
    finishedAt: null,
    reviewSince: null,
    createdAt: at(46),
    decisions: { attemptId: null, poll: false, resolve: false, refund: false },
    attempts: [],
    events: [
      {
        id: id(400),
        kind: 'status',
        fromStatus: null,
        toStatus: 'paid',
        actor: 'customer',
        attemptId: null,
        reason: null,
        details: {},
        createdAt: at(46),
      },
    ],
    journals: [{ id: id(500), kind: 'purchase', amountUsdUnits: 990_000, createdAt: at(46) }],
    codes: [],
    checkout: null,
    gift: null,
    shareLinks: [],
    ...fields,
  };
  return withDecisions(base);
}

function withDecisions(row: AdminOrder): AdminOrder {
  const open = row.attempts.find((item) => ['sending', 'pending', 'unknown'].includes(item.status));
  return {
    ...row,
    decisions: orderDecisions(
      row.status,
      open ? { id: open.id, supplierCode: open.supplierCode } : null,
    ),
  };
}

function seed(): AdminOrder[] {
  return [
    order('held', 'VO-HELD23', {
      status: 'needs_review',
      reviewSince: at(15),
      attempts: [attempt(1, { code: 'wdgzone', nameAr: 'WDGZone' }, 'unknown')],
    }),
    order('manual', 'VO-MANU45', {
      status: 'sent_to_supplier',
      customer: testCustomer,
      product: { id: id(71), nameAr: 'بطاقة آيتونز 10$', kind: 'code' },
      game: itunes,
      fields: [],
      quantity: 2,
      unitPriceUsdUnits: 10_600_000,
      totalUsdUnits: 21_200_000,
      totalSypUnits: null,
      attempts: [
        attempt(2, { code: 'manual', nameAr: 'يدوي' }, 'pending', {
          quantity: 2,
          supplierOrderId: null,
          unitCostUsdUnits: 9_700_000,
        }),
      ],
    }),
    order('delivered', 'VO-DONE67', {
      status: 'delivered',
      product: { id: id(72), nameAr: 'بطاقة آيتونز 10$', kind: 'code' },
      game: itunes,
      fields: [],
      deliveredQuantity: 1,
      deliveredAt: at(44),
      finishedAt: at(44),
      attempts: [
        attempt(3, { code: 'fake', nameAr: 'مورد تجريبي' }, 'delivered', {
          webhookEvents: [
            {
              id: id(600),
              eventId: 'evt-1',
              result: 'same_result',
              processedAt: at(43),
              createdAt: at(43),
            },
          ],
        }),
      ],
      journals: [
        { id: id(501), kind: 'purchase', amountUsdUnits: 990_000, createdAt: at(46) },
        { id: id(502), kind: 'cost_of_goods', amountUsdUnits: 880_000, createdAt: at(44) },
      ],
      codes: [
        {
          id: id(700),
          attemptId: id(103),
          position: 1,
          masked: '•••• 7Q2M',
          reveals: [
            {
              actor: 'customer',
              ipAddress: '203.0.113.7',
              userAgent: 'Chrome على Android',
              createdAt: at(40),
            },
          ],
        },
      ],
    }),
    order('refunded', 'VO-BACK89', {
      status: 'refunded',
      refundedQuantity: 1,
      refundedUsdUnits: 990_000,
      refundReason: 'input_rejected',
      finishedAt: at(30),
      attempts: [
        attempt(4, { code: 'fake', nameAr: 'مورد تجريبي' }, 'failed', {
          inputRejected: true,
          supplierErrorCode: 'PLAYER_NOT_FOUND',
          failureReason: 'Player not found',
          resolvedBy: 'supplier',
          resolvedAt: at(30),
        }),
      ],
    }),
  ];
}

function summary(row: AdminOrder): AdminOrderSummary {
  const open = row.attempts.find((item) => ['sending', 'pending', 'unknown'].includes(item.status));
  const latest = open ?? row.attempts[0];
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    customer: row.customer,
    product: { id: row.product.id, nameAr: row.product.nameAr },
    game: row.game,
    quantity: row.quantity,
    totalUsdUnits: row.totalUsdUnits,
    supplierCode: latest?.supplierCode ?? null,
    manualWaiting: open?.supplierCode === 'manual',
    checkoutId: row.checkout?.id ?? null,
    isGift: row.gift !== null,
    since: row.reviewSince ?? row.finishedAt ?? row.paidAt ?? row.createdAt,
    createdAt: row.createdAt,
  };
}

export class OrdersMock {
  orders: AdminOrder[] = seed();
  policy: OrderPolicy = { ...ORDER_POLICY_DEFAULTS };
  /** The codes a reveal returns, by code id. */
  readonly codeValues = new Map<string, string>([[id(700), 'ITUNES-7K2M-9Q4X-7Q2M']]);
  /** A decision's key and its order, for the replay of the first result. */
  private readonly keys = new Map<string, string>();

  constructor(private readonly reauthenticationRequired: () => boolean) {}

  private find(orderId: string) {
    return this.orders.find((row) => row.id === orderId);
  }

  private replace(next: AdminOrder) {
    const changed = withDecisions(next);
    this.orders = this.orders.map((row) => (row.id === changed.id ? changed : row));
    return changed;
  }

  counts() {
    return {
      needsReview: this.orders.filter((row) => row.status === 'needs_review').length,
      manualWaiting: this.orders.filter((row) => summary(row).manualWaiting).length,
    };
  }

  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;

    if (key === 'GET /api/admin/orders/counts') return { status: 200, json: this.counts() };
    if (key === 'GET /api/admin/orders/policy') return { status: 200, json: this.policy };
    if (key === 'PUT /api/admin/orders/policy') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = orderPolicySchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      this.policy = parsed.data;
      return { status: 200, json: this.policy };
    }
    if (key === 'GET /api/admin/orders') {
      const tab = (url.searchParams.get('tab') ?? 'all') as AdminOrderTab;
      const q = url.searchParams.get('q')?.toLowerCase();
      const supplier = url.searchParams.get('supplier');
      const status = url.searchParams.get('status');
      const productId = url.searchParams.get('productId');
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 50);
      const items = this.orders
        .map(summary)
        .filter((row) =>
          tab === 'all'
            ? true
            : tab === 'manual'
              ? row.manualWaiting
              : ADMIN_ORDER_TAB_STATUSES[tab].includes(row.status),
        )
        .filter(
          (row) =>
            !q ||
            row.number.toLowerCase().includes(q.replace(/^vo-?/, '')) ||
            row.customer.email.includes(q) ||
            row.checkoutId === q,
        )
        .filter((row) => !supplier || row.supplierCode === supplier)
        .filter((row) => !status || row.status === status)
        .filter((row) => !productId || row.product.id === productId);
      return {
        status: 200,
        json: {
          items: items.slice((page - 1) * pageSize, page * pageSize),
          total: items.length,
          page,
          pageSize,
        },
      };
    }

    const one = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (one && method === 'GET') {
      const row = this.find(one[1] as string);
      return row ? { status: 200, json: row } : error(404, 'NOT_FOUND');
    }

    // S10 rule AD1: an admin revocation, with its reason; a revoked link answers the order again.
    const revoke = path.match(/^\/api\/admin\/orders\/([^/]+)\/share-links\/([^/]+)\/revoke$/);
    if (revoke && method === 'POST') {
      const row = this.find(revoke[1] as string);
      const link = row?.shareLinks.find((item) => item.id === revoke[2]);
      if (!row || !link) return error(404, 'NOT_FOUND');
      const parsed = revokeShareLinkSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      if (link.revokedAt) return { status: 200, json: row };
      return {
        status: 200,
        json: this.replace({
          ...row,
          shareLinks: row.shareLinks.map((item) =>
            item.id === link.id
              ? {
                  ...item,
                  revokedAt: new Date().toISOString(),
                  revokedBy: 'admin',
                  revokeReason: parsed.data.reason,
                }
              : item,
          ),
        }),
      };
    }

    const decision = path.match(
      /^\/api\/admin\/orders\/([^/]+)\/(?:attempts\/([^/]+)\/(poll|resolve)|(refund)|codes\/([^/]+)\/reveal)$/,
    );
    if (!decision || method !== 'POST') return null;
    const [, orderId, attemptId, attemptAction, refundAction, codeId] = decision;
    const row = this.find(orderId as string);
    if (!row) return error(404, 'NOT_FOUND');
    const refused = sensitive();
    if (refused) return refused;

    if (codeId) {
      const value = this.codeValues.get(codeId);
      if (!value) return error(404, 'NOT_FOUND');
      this.replace({
        ...row,
        codes: row.codes.map((code) =>
          code.id === codeId
            ? {
                ...code,
                reveals: [
                  ...code.reveals,
                  {
                    actor: 'admin',
                    ipAddress: '127.0.0.1',
                    userAgent: 'Chrome',
                    createdAt: new Date().toISOString(),
                  },
                ],
              }
            : code,
        ),
      });
      return { status: 200, json: { code: value } };
    }

    const idempotencyKey = this.idempotencyKey;
    this.idempotencyKey = null;
    if (idempotencyKey && this.keys.has(idempotencyKey)) {
      return { status: 200, json: this.find(this.keys.get(idempotencyKey) as string) };
    }
    const remember = (changed: AdminOrder): Answer => {
      if (idempotencyKey) this.keys.set(idempotencyKey, changed.id);
      return { status: 200, json: changed };
    };
    const now = new Date().toISOString();

    if (refundAction) {
      if (!row.decisions.refund) return error(409, 'ORDER_NOT_DECIDABLE');
      const parsed = refundOrderSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const units = row.quantity - row.deliveredQuantity - row.refundedQuantity;
      return remember(
        this.replace({
          ...row,
          status: row.deliveredQuantity > 0 ? 'partially_refunded' : 'refunded',
          refundedQuantity: row.refundedQuantity + units,
          refundedUsdUnits: (row.refundedQuantity + units) * row.unitPriceUsdUnits,
          refundReason: 'admin',
          finishedAt: now,
          reviewSince: null,
          attempts: row.attempts.map((item) =>
            item.id === row.decisions.attemptId
              ? {
                  ...item,
                  status: 'failed',
                  resolvedBy: 'admin',
                  resolvedAt: now,
                  adminReason: parsed.data.reason,
                }
              : item,
          ),
        }),
      );
    }

    if (attemptId !== row.decisions.attemptId) return error(409, 'ATTEMPT_NOT_RESOLVABLE');
    if (attemptAction === 'poll') {
      if (!row.decisions.poll) return error(409, 'ATTEMPT_NOT_RESOLVABLE');
      return { status: 202, json: row };
    }
    if (!row.decisions.resolve) return error(409, 'ATTEMPT_NOT_RESOLVABLE');
    const parsed = resolveAttemptSchema.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED');
    const resolved = parsed.data;
    if (resolved.outcome === 'delivered') {
      const codeCount = resolved.codes.length;
      if (row.product.kind === 'code' ? codeCount !== resolved.quantity : codeCount > 0) {
        return error(400, 'CODES_COUNT_MISMATCH');
      }
      const delivered = row.deliveredQuantity + resolved.quantity;
      const done = delivered === row.quantity;
      return remember(
        this.replace({
          ...row,
          status: done ? 'delivered' : 'failed',
          deliveredQuantity: delivered,
          deliveredAt: done ? now : null,
          finishedAt: done ? now : null,
          reviewSince: null,
          attempts: row.attempts.map((item) =>
            item.id === attemptId
              ? {
                  ...item,
                  status: 'delivered',
                  deliveredQuantity: resolved.quantity,
                  resolvedBy: 'admin',
                  resolvedAt: now,
                  adminReason: resolved.reason,
                }
              : item,
          ),
          codes: [
            ...row.codes,
            ...resolved.codes.map((_code, index) => ({
              id: `${attemptId}-${index}`,
              attemptId: attemptId as string,
              position: row.codes.length + index + 1,
              masked: '••••',
              reveals: [],
            })),
          ],
        }),
      );
    }
    // Failed: no route is left in the mock, so the remaining units are refunded.
    const units = row.quantity - row.deliveredQuantity - row.refundedQuantity;
    return remember(
      this.replace({
        ...row,
        status: row.deliveredQuantity > 0 ? 'partially_refunded' : 'refunded',
        refundedQuantity: row.refundedQuantity + units,
        refundedUsdUnits: (row.refundedQuantity + units) * row.unitPriceUsdUnits,
        refundReason: 'routes_exhausted',
        finishedAt: now,
        reviewSince: null,
        attempts: row.attempts.map((item) =>
          item.id === attemptId
            ? {
                ...item,
                status: 'failed',
                resolvedBy: 'admin',
                resolvedAt: now,
                adminReason: resolved.reason,
              }
            : item,
        ),
      }),
    );
  }

  /** The `Idempotency-Key` of the request being answered, set by the caller. */
  idempotencyKey: string | null = null;
}
