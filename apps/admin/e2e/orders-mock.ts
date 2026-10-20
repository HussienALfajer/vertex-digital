import {
  ADMIN_ORDER_TAB_STATUSES,
  type AdminOrder,
  type AdminOrderSummary,
  type AdminOrderTab,
  type AdminPurchaseContext,
  adminOrderShape,
  type CheckCategory,
  createAdminOrderSchema,
  fulfilIsLoss,
  fulfilOrderSchema,
  type GamePlayerCheck,
  LIVE_COLUMNS,
  type LiveBoard,
  type LiveOrderCard,
  liveColumn,
  ORDER_POLICY_DEFAULTS,
  type OrderPolicy,
  orderDecisions,
  orderPolicySchema,
  orderTotal,
  type PlayerCheck,
  type Product,
  type RerouteOptions,
  refundOrderSchema,
  rerouteOrderSchema,
  resolveAttemptSchema,
  revokeShareLinkSchema,
  unmappedFields,
  updateGamePlayerCheckSchema,
} from '@vertex-digital/contracts';
import type { Answer } from './catalog-mock';

/*
 * The orders API of S08 as the panel sees it: four orders (held for review, a manual one
 * waiting, delivered, refunded), the counts, the decisions with re-authentication and their
 * `Idempotency-Key` replays (rules D1–D5), code reveals (C3) and the policy. A decision changes
 * the order as the write path would, on the contracts' rules (`orderDecisions`). S11: the live
 * board on `liveColumn`, each order's route options, reroute, the delivery proof and the manual
 * fulfil; `addLiveOrders()` adds two orders at the supplier (one slow) for the live room.
 */

type Body = Record<string, unknown> | null;

/** S16: what a purchase from the panel reads of the other mocks. */
export interface PurchaseShop {
  product(productId: string): { product: Product; game: { id: string; nameAr: string } } | null;
  customer(customerId: string): {
    id: string;
    name: string;
    email: string;
    isTest: boolean;
    emailVerified: boolean;
    frozen: boolean;
    archived: boolean;
    balanceUnits: number;
  } | null;
  /** Takes the total from the customer's wallet (`on_behalf`). */
  charge(customerId: string, units: number): void;
}

const NO_SHOP: PurchaseShop = {
  product: () => null,
  customer: () => null,
  charge: () => {},
};

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const id = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const ORDER_IDS = {
  held: id(1),
  manual: id(2),
  delivered: id(3),
  refunded: id(4),
  slow: id(5),
  fresh: id(6),
};

/** The fake supplier's route, the one a reroute picks in the tests (S11 rule RR2). */
export const FAKE_ROUTE_ID = id(250);

/** The products' routes (S11 rule RR2): the unit cost is a share of the price, in whole cents. */
const ROUTES = [
  { routeId: FAKE_ROUTE_ID, code: 'fake', nameAr: 'مورد تجريبي', share: 0.86, tier: 'healthy' },
  { routeId: id(251), code: 'wdgzone', nameAr: 'WDGZone', share: 0.89, tier: 'healthy' },
  { routeId: id(252), code: 'manual', nameAr: 'يدوي', share: 0.8, tier: 'manual' },
] as const;

/** The customer of most orders; S12: the customers mock's Sara, so her profile lists them. */
export const ORDER_CUSTOMER_ID = id(90);

/** S12 CS6: the customer panel's marks on the order page. */
const marks = { status: 'active' as const, pinnedNote: null, signalsCount: 0 };
const customer = {
  id: ORDER_CUSTOMER_ID,
  name: 'سارة',
  email: 'sara@example.com',
  isTest: false,
  marks,
};
const testCustomer = { id: id(91), name: 'تجربة', email: 'test@example.com', isTest: true, marks };
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
    kind: 'routed',
    routeId: id(200 + n),
    supplierCode: supplier.code,
    supplierNameAr: supplier.nameAr,
    offerId: `${supplier.code}-offer`,
    offerName: 'UC 60',
    quantity: 1,
    deliveredQuantity: status === 'delivered' ? 1 : 0,
    unitCostUsdUnits: 880_000,
    chosenByAdmin: false,
    proofFileId: null,
    deliveryReference: null,
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
        supplierCode: 'fake',
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
    placedBy: 'customer',
    payer: 'customer',
    purpose: null,
    adminReason: null,
    customerNote: null,
    product: { id: id(70), nameAr: '60 UC', kind: 'direct' },
    game: pubg,
    fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب', value: '5123456789', valueLabelAr: null }],
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
    playerRegion: null,
    paidAt: at(46),
    deliveredAt: null,
    finishedAt: null,
    reviewSince: null,
    createdAt: at(46),
    decisions: {
      attemptId: null,
      poll: false,
      resolve: false,
      resolveDelivered: false,
      refund: false,
      reroute: false,
      fulfil: false,
    },
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

const OPEN = ['sending', 'pending', 'unknown'];

const remaining = (row: AdminOrder) => row.quantity - row.deliveredQuantity - row.refundedQuantity;

/** S11 rule LR2: an order as the live room's card shows it. */
function card(row: AdminOrder): LiveOrderCard {
  const open = row.attempts.find((item) => OPEN.includes(item.status));
  const latest = open ?? row.attempts[0];
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    game: row.game,
    product: { id: row.product.id, nameAr: row.product.nameAr },
    quantity: row.quantity,
    totalUsdUnits: row.totalUsdUnits,
    isTest: row.customer?.isTest ?? false,
    customerEmail: row.customer?.email ?? null,
    purpose: row.purpose,
    attempt: latest
      ? {
          supplierCode: latest.supplierCode,
          supplierNameAr: latest.supplierNameAr,
          status: latest.status,
        }
      : null,
    paidAt: row.paidAt ?? row.createdAt,
    sentAt: open?.sentAt ?? null,
    reviewSince: row.reviewSince,
    finishedAt: row.finishedAt,
    // Without delivery stats: slow after 10 minutes; the two added orders measure 2 minutes.
    slowAfterSeconds: null,
  };
}

/** S11 rule RR2, as the API decides it for these orders. */
function routeOptions(row: AdminOrder): RerouteOptions {
  return {
    orderId: row.id,
    remainingUnits: remaining(row),
    unitPriceUsdUnits: row.unitPriceUsdUnits,
    minMarginUsdUnits: row.minMarginUsdUnits,
    routes: ROUTES.map((route) => {
      const cost = Math.round((row.unitPriceUsdUnits * route.share) / 10_000) * 10_000;
      const tried = row.attempts.some(
        (item) => item.kind === 'routed' && item.supplierCode === route.code,
      );
      const skipReason = tried
        ? 'already_tried'
        : row.customer?.isTest && route.code === 'wdgzone'
          ? 'test_customer'
          : null;
      return {
        routeId: route.routeId,
        supplierCode: route.code,
        supplierNameAr: route.nameAr,
        health: 'healthy',
        balanceUsdUnits: route.code === 'manual' ? null : 250_000_000,
        balanceAt: route.code === 'manual' ? null : new Date(Date.now() - 4 * 60_000).toISOString(),
        offerId: `${route.code}-offer`,
        offerName: row.product.nameAr,
        tier: route.tier,
        unitCostUsdUnits: cost,
        marginUsdUnits: row.unitPriceUsdUnits - cost,
        eligible: skipReason === null,
        skipReason,
      };
    }),
  };
}

function summary(row: AdminOrder): AdminOrderSummary {
  const open = row.attempts.find((item) => ['sending', 'pending', 'unknown'].includes(item.status));
  const latest = open ?? row.attempts[0];
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    customer: row.customer,
    placedBy: row.placedBy,
    payer: row.payer,
    purpose: row.purpose,
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
  /** S11 rule MF2: the delivery proofs uploaded, and those an attempt holds. */
  private readonly proofs = new Set<string>();
  private proofCount = 0;

  /** Two orders at the supplier for the live room: one paid 5 minutes ago (slow), one just now. */
  addLiveOrders() {
    const sent = (minutesAgo: number, n: number): AdminOrder =>
      order(n === 5 ? 'slow' : 'fresh', n === 5 ? 'VO-SLOW52' : 'VO-NEWW63', {
        status: 'sent_to_supplier',
        paidAt: at(minutesAgo),
        createdAt: at(minutesAgo),
        attempts: [
          attempt(n, { code: 'fake', nameAr: 'مورد تجريبي' }, 'pending', {
            sentAt: at(minutesAgo),
            createdAt: at(minutesAgo),
            supplierOrderId: `S-${n}`,
          }),
        ],
      });
    this.orders = [...this.orders, sent(5, 5), sent(0.2, 6)];
  }

  /** The order's card in the live room delivers now (the stream test's next read). */
  deliver(orderId: string) {
    const row = this.find(orderId);
    if (!row) return;
    const now = new Date().toISOString();
    this.replace({
      ...row,
      status: 'delivered',
      deliveredQuantity: row.quantity,
      deliveredAt: now,
      finishedAt: now,
      attempts: row.attempts.map((item, index) =>
        index === 0
          ? { ...item, status: 'delivered', deliveredQuantity: row.quantity, resolvedAt: now }
          : item,
      ),
    });
  }

  /** S11 rule LR1 over the mock's orders. */
  board(url: URL): LiveBoard {
    const now = new Date();
    const supplier = url.searchParams.get('supplier');
    const gameId = url.searchParams.get('gameId');
    const test = url.searchParams.get('test') ?? 'all';
    const rows = this.orders
      .filter((row) =>
        test === 'hide' ? !row.customer?.isTest : test === 'only' ? !!row.customer?.isTest : true,
      )
      .filter((row) => !gameId || row.game.id === gameId)
      .filter((row) => !supplier || card(row).attempt?.supplierCode === supplier);
    const columns = Object.fromEntries(
      LIVE_COLUMNS.map((column) => {
        const cards = rows
          .filter((row) => {
            const open = row.attempts.find((item) => OPEN.includes(item.status));
            return (
              liveColumn(
                {
                  status: row.status,
                  finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
                },
                open ? { supplierCode: open.supplierCode } : null,
                now,
              ) === column
            );
          })
          .map((row) => ({
            ...card(row),
            slowAfterSeconds:
              column !== 'at_supplier'
                ? null
                : row.id === ORDER_IDS.slow || row.id === ORDER_IDS.fresh
                  ? 120
                  : 600,
          }));
        if (column === 'finished') cards.reverse();
        return [column, { count: cards.length, cards }];
      }),
    ) as LiveBoard['columns'];
    return {
      columns,
      awaitingBalance: rows.filter((row) => row.status === 'awaiting_balance').length,
      generatedAt: now.toISOString(),
    };
  }

  /** S16: owner-funded totals paid today, for the owner cap (AP7). */
  ownerUsedToday = 0;
  /** S16: what the next admin player check answers (AP8). */
  nextPlayerCheck: PlayerCheck = {
    result: 'valid',
    playerName: 'Player 6789',
    region: null,
  };
  /** S19 PC1: the games' check provider rows, by game id. */
  readonly gameChecks = new Map<string, GamePlayerCheck>();
  /** S19 PC1: the fake provider's check categories (its `listCheckCategories`). */
  checkCategories: CheckCategory[] = [
    {
      categoryId: 'player',
      name: 'Fake player check',
      fields: [{ key: 'player_id', label: 'Player ID', type: 'text' }],
    },
    { categoryId: 'zone', name: 'Fake zone check', fields: [] },
  ];

  constructor(
    private readonly reauthenticationRequired: () => boolean,
    private readonly shop: PurchaseShop = NO_SHOP,
  ) {}

  /** S16 rules AP4, AP7: the dialog's context. */
  private purchaseContext(customerId: string | null): Answer {
    const owner = {
      capUsdUnits: this.policy.ownerDailyCapUsdUnits,
      usedTodayUsdUnits: this.ownerUsedToday,
      remainingUsdUnits: Math.max(0, this.policy.ownerDailyCapUsdUnits - this.ownerUsedToday),
    };
    if (!customerId) return { status: 200, json: { customer: null, owner } };
    const found = this.shop.customer(customerId);
    if (!found || found.archived) return error(404, 'NOT_FOUND');
    const context: AdminPurchaseContext = {
      customer: {
        id: found.id,
        name: found.name,
        email: found.email,
        isTest: found.isTest,
        emailVerified: found.emailVerified,
        frozen: found.frozen,
        balanceUsdUnits: found.balanceUnits,
        purchaseCapLeftUsdUnits: null,
        savedPlayers: [],
      },
      owner,
    };
    return { status: 200, json: context };
  }

  /** S16 rules AP2–AP9 as the write path decides them, for the mock's catalog and customers. */
  private purchase(body: Body): Answer {
    if (this.reauthenticationRequired()) return error(403, 'REAUTHENTICATION_REQUIRED');
    const idempotencyKey = this.idempotencyKey;
    this.idempotencyKey = null;
    if (!idempotencyKey) return error(400, 'VALIDATION_FAILED');
    if (this.keys.has(idempotencyKey)) {
      return { status: 200, json: this.find(this.keys.get(idempotencyKey) as string) };
    }
    const parsed = createAdminOrderSchema.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED');
    const input = parsed.data;
    const shape = adminOrderShape(input.purpose);
    const found = this.shop.product(input.productId);
    if (!found) return error(404, 'NOT_FOUND');
    const { product, game } = found;
    const buyer = input.customerId ? this.shop.customer(input.customerId) : null;
    if (input.customerId && (!buyer || buyer.archived)) return error(404, 'NOT_FOUND');
    if (buyer?.frozen) return error(403, 'ACCOUNT_FROZEN');
    const buyable =
      product.availability === 'available' ||
      (product.availability === 'paused' && shape.payer === 'owner');
    if (!buyable || product.priceUsdUnits === null) {
      return error(409, 'PRODUCT_UNAVAILABLE', { availability: product.availability });
    }
    if (product.priceUsdUnits !== input.expectedUnitPriceUsdUnits) {
      return error(409, 'PRICE_CHANGED', { unitPriceUsdUnits: product.priceUsdUnits });
    }
    const total = orderTotal(product.priceUsdUnits, input.quantity);
    if (shape.payer === 'owner') {
      const left = Math.max(0, this.policy.ownerDailyCapUsdUnits - this.ownerUsedToday);
      if (total > left) return error(409, 'OWNER_DAILY_CAP_EXCEEDED', { remainingUsdUnits: left });
      this.ownerUsedToday += total;
    } else if (buyer) {
      if (buyer.balanceUnits < total) return error(409, 'INSUFFICIENT_BALANCE');
      this.shop.charge(buyer.id, total);
    }
    const n = 900 + this.keys.size;
    const now = new Date().toISOString();
    const created = withDecisions({
      ...order('fresh', `VO-ADM${String(this.keys.size + 2).padStart(3, '2')}`, {}),
      id: id(n),
      customer: buyer
        ? { id: buyer.id, name: buyer.name, email: buyer.email, isTest: buyer.isTest, marks }
        : null,
      placedBy: 'admin',
      payer: shape.payer,
      purpose: input.purpose,
      adminReason: input.reason,
      customerNote: input.customerNote ?? null,
      product: { id: product.id, nameAr: product.nameAr, kind: product.kind },
      game,
      fields: Object.entries(input.fields).map(([key, value]) => ({
        key,
        labelAr: key,
        value,
        valueLabelAr: null,
      })),
      quantity: input.quantity,
      unitPriceUsdUnits: product.priceUsdUnits,
      totalUsdUnits: total,
      paidAt: now,
      createdAt: now,
      events: [],
      attempts: [],
    });
    this.orders = [created, ...this.orders];
    this.keys.set(idempotencyKey, created.id);
    return { status: 201, json: created };
  }

  /** S19 PC1: `GET`/`PUT /api/admin/catalog/games/:id/player-check`, checked as the API does. */
  gamePlayerCheck(method: string, gameId: string, body: unknown, gameKeys: string[]): Answer {
    if (method === 'GET') {
      return { status: 200, json: { check: this.gameChecks.get(gameId) ?? null } };
    }
    if (this.reauthenticationRequired()) return error(403, 'REAUTHENTICATION_REQUIRED');
    const parsed = updateGamePlayerCheckSchema.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED');
    const input = parsed.data;
    if (input.supplierCode !== 'fake') return error(409, 'CAPABILITY_UNSUPPORTED');
    const category = this.checkCategories.find((item) => item.categoryId === input.categoryId);
    if (input.enabled && !category) {
      return error(400, 'VALIDATION_FAILED', [{ path: ['categoryId'], message: 'Unknown' }]);
    }
    const theirs = category?.fields.map((field) => field.key) ?? [];
    if (
      !Object.values(input.fieldMap).every((key) => gameKeys.includes(key)) ||
      (category && unmappedFields(theirs, input.fieldMap).length > 0)
    ) {
      return error(400, 'VALIDATION_FAILED', [{ path: ['fieldMap'], message: 'Unmapped' }]);
    }
    const check: GamePlayerCheck = { gameId, ...input, updatedAt: new Date().toISOString() };
    this.gameChecks.set(gameId, check);
    return { status: 200, json: { check } };
  }

  /** S16 rule AP8: the admin's player check. */
  playerCheck(): Answer {
    return { status: 200, json: this.nextPlayerCheck };
  }

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
      const customerId = url.searchParams.get('customerId');
      const placedBy = url.searchParams.get('placedBy');
      const payer = url.searchParams.get('payer');
      const purpose = url.searchParams.get('purpose');
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
            !!row.customer?.email.includes(q) ||
            row.checkoutId === q,
        )
        .filter((row) => !supplier || row.supplierCode === supplier)
        .filter((row) => !status || row.status === status)
        .filter((row) => !productId || row.product.id === productId)
        .filter((row) => !customerId || row.customer?.id === customerId)
        .filter((row) => !placedBy || row.placedBy === placedBy)
        .filter((row) => !payer || row.payer === payer)
        .filter((row) => !purpose || row.purpose === purpose);
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

    if (key === 'GET /api/admin/orders/live') return { status: 200, json: this.board(url) };
    if (key === 'GET /api/admin/orders/purchase-context') {
      return this.purchaseContext(url.searchParams.get('customerId'));
    }
    if (key === 'POST /api/admin/orders') return this.purchase(body);

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

    // S11 (F17): the live board and an order's routes, proof and manual fulfil.
    const s11 = path.match(
      /^\/api\/admin\/orders\/([^/]+)\/(routes|reroute|proof|fulfil|proofs\/([^/]+))$/,
    );
    if (s11) {
      const [, orderId, action, fileId] = s11;
      const row = this.find(orderId as string);
      if (!row) return error(404, 'NOT_FOUND');
      if (action === 'routes' && method === 'GET') {
        if (!row.decisions.reroute && !row.decisions.fulfil) {
          return error(409, 'ORDER_NOT_DECIDABLE');
        }
        return { status: 200, json: routeOptions(row) };
      }
      if (fileId && method === 'GET') {
        const held = row.attempts.some((item) => item.proofFileId === fileId);
        return held ? { status: 200, image: true } : error(404, 'NOT_FOUND');
      }
      if (method !== 'POST') return null;
      const refused = sensitive();
      if (refused) return refused;
      if (action === 'proof') {
        if (!row.decisions.fulfil) return error(409, 'ORDER_NOT_DECIDABLE');
        this.proofCount += 1;
        const fileId = id(800 + this.proofCount);
        this.proofs.add(fileId);
        return { status: 201, json: { fileId } };
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
      const openId = row.decisions.attemptId;
      const closeOpen = (reason: string) =>
        row.attempts.map((item) =>
          item.id === openId
            ? {
                ...item,
                status: 'failed' as const,
                resolvedBy: 'admin' as const,
                resolvedAt: now,
                adminReason: reason,
              }
            : item,
        );

      if (action === 'reroute') {
        if (!row.decisions.reroute) return error(409, 'ORDER_NOT_DECIDABLE');
        const parsed = rerouteOrderSchema.safeParse(body);
        if (!parsed.success) return error(400, 'VALIDATION_FAILED');
        const route = routeOptions(row).routes.find((item) => item.routeId === parsed.data.routeId);
        if (!route?.eligible) {
          return error(409, 'ROUTE_NOT_ELIGIBLE', { reason: route?.skipReason ?? 'archived' });
        }
        const manual = route.supplierCode === 'manual';
        return remember(
          this.replace({
            ...row,
            status: 'sent_to_supplier',
            reviewSince: null,
            attempts: [
              {
                ...attempt(
                  900 + row.attempts.length,
                  { code: route.supplierCode as 'fake', nameAr: route.supplierNameAr },
                  manual ? 'pending' : 'sending',
                ),
                id: id(950 + this.keys.size),
                routeId: route.routeId,
                quantity: remaining(row),
                unitCostUsdUnits: route.unitCostUsdUnits ?? 0,
                chosenByAdmin: true,
                supplierOrderId: null,
                candidates: [],
                sentAt: manual ? null : now,
                createdAt: now,
              },
              ...closeOpen(parsed.data.reason),
            ],
          }),
        );
      }

      // Rules MF1–MF5.
      if (!row.decisions.fulfil) return error(409, 'ORDER_NOT_DECIDABLE');
      const parsed = fulfilOrderSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const input = parsed.data;
      if (!this.proofs.has(input.proofFileId)) return error(400, 'PROOF_INVALID');
      if (input.quantity > remaining(row)) return error(400, 'VALIDATION_FAILED');
      const codeCount = input.codes.length;
      if (row.product.kind === 'code' ? codeCount !== input.quantity : codeCount > 0) {
        return error(400, 'CODES_COUNT_MISMATCH');
      }
      if (fulfilIsLoss(input.unitCostUsdUnits, row.unitPriceUsdUnits) && !input.acceptLoss) {
        return error(409, 'LOSS_NOT_CONFIRMED', {
          unitCostUsdUnits: input.unitCostUsdUnits,
          unitPriceUsdUnits: row.unitPriceUsdUnits,
        });
      }
      this.proofs.delete(input.proofFileId);
      const delivered = row.deliveredQuantity + input.quantity;
      const done = delivered === row.quantity;
      const fulfilled = {
        status: 'delivered' as const,
        deliveredQuantity: input.quantity,
        unitCostUsdUnits: input.unitCostUsdUnits,
        proofFileId: input.proofFileId,
        deliveryReference: input.reference ?? null,
        resolvedBy: 'admin' as const,
        resolvedAt: now,
        adminReason: input.reason,
      };
      const open = row.attempts.find((item) => item.id === openId);
      const attempts =
        open?.supplierCode === 'manual'
          ? row.attempts.map((item) => (item.id === openId ? { ...item, ...fulfilled } : item))
          : [
              {
                ...attempt(960, { code: 'manual', nameAr: 'يدوي' }, 'delivered'),
                id: id(960 + this.keys.size),
                kind: 'admin_fulfil' as const,
                routeId: null,
                offerId: null,
                offerName: null,
                quantity: input.quantity,
                supplierOrderId: null,
                candidates: [],
                sentAt: null,
                createdAt: now,
                ...fulfilled,
              },
              ...closeOpen(input.reason),
            ];
      return remember(
        this.replace({
          ...row,
          status: done ? 'delivered' : row.status === 'needs_review' ? 'needs_review' : 'failed',
          deliveredQuantity: delivered,
          deliveredAt: done ? now : null,
          finishedAt: done ? now : null,
          reviewSince: done ? null : row.reviewSince,
          attempts,
          codes: [
            ...row.codes,
            ...input.codes.map((_code, index) => ({
              id: `${now}-${index}`,
              attemptId: attempts[0]?.id ?? '',
              position: row.codes.length + index + 1,
              masked: '••••',
              reveals: [],
            })),
          ],
          journals:
            input.unitCostUsdUnits > 0
              ? [
                  ...row.journals,
                  {
                    id: id(970 + this.keys.size),
                    kind: 'cost_of_goods',
                    amountUsdUnits: input.unitCostUsdUnits * input.quantity,
                    createdAt: now,
                  },
                ]
              : row.journals,
        }),
      );
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
      // S11 rule MF1: a manual attempt is delivered only by the manual fulfil.
      if (!row.decisions.resolveDelivered) {
        return error(409, 'ATTEMPT_NOT_RESOLVABLE', { use: 'fulfil' });
      }
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
