import { randomBytes, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { type FieldSpec, type ProductKind, USD_CENT } from '@vertex-digital/contracts';
import { z } from 'zod';
import type {
  ImageLimits,
  OrderFields,
  PlaceOrderRequest,
  PlayerValidation,
  SupplierAdapter,
  SupplierCapabilities,
  SupplierCategory,
  SupplierMoney,
  SupplierOffer,
  SupplierOrderRow,
  SupplierOutcome,
  SupplierPlatformStatus,
  SupplierStatementPage,
  SupplierTransactionRow,
  SupplierWebhookEvent,
  WebhookRequest,
} from '../core/adapter.js';
import { SupplierError } from '../core/errors.js';
import { hmacSha256, verifyHmacSignature } from '../core/hmac.js';
import { imageUrlAllowed } from '../core/image.js';

/*
 * The `fake` supplier (ADR 0005): in-process, for development, tests and E2E. Nothing leaves the
 * machine. The outcome of an order is scripted by the start of its `playerId` field:
 *
 *   delivered (anything else)  delivered at once (codes for code offers)
 *   slow…                      delivered after `slowMs`
 *   pending…                   pending; `completePending` returns the signed webhook
 *   fail…                      refused: failed_definitive (`FAKE_REFUSED`)
 *   unknown…                   unknown (as after a timeout); polling finds it delivered
 *   badsig…                    pending; its webhook carries a wrong signature
 *   invalid…                   `validatePlayer` answers invalid; an order is refused with
 *                              `inputRejected` (`PLAYER_NOT_FOUND`)
 *
 * Its catalog (S07) is about ten offers in three groups, changed by a `FakeSupplierState`: costs,
 * stock, removed offers, a failing sync, every call failing, the balance. The worker reads that
 * state from a git-ignored file the `supplier:fake` CLI writes (development and E2E only).
 *
 * S08: an offer's script (`orderScripts`, `supplier:fake --order`) decides its next orders before
 * the `playerId` prefix does (a code offer has no player): `delivered`, `pending` (until
 * resolved), `failed`, `invalid` (input rejected), `unknown` (no answer until resolved),
 * `partial:<n>` (n units delivered, the rest failed), `slow:<seconds>`; S16 `resend-refused` (the
 * first send buys but answers unknown, a re-send of its key is refused). Orders are kept in the
 * state (`orders`): each change is handed to `onOrder`, which the worker persists, so a poll, a
 * repeated key and `supplier:fake --resolve` find them across calls and processes.
 *
 * S16: a category tree (PUBG Mobile and Free Fire with subcategories, gift cards; PR 4: Mobile
 * Legends with a zone field, Genshin Impact with a region select) whose images are bundled PNGs on
 * `fake-supplier.invalid`; an order missing a field or with a value outside a select's options is
 * refused (`FIELD_REFUSED`), offers with stock, original prices and field specs, a
 * statement built from its own orders and a platform status. The state scripts stock counts
 * (`--stock-count`), missing categories (`--category-missing`) and added offers (`--add-offer`).
 */

export const FAKE_SUPPLIER_CODE = 'fake';

/** The headers of a fake webhook: Unix seconds, and HMAC-SHA256 hex of `${timestamp}.${body}`. */
export const FAKE_TIMESTAMP_HEADER = 'x-fake-timestamp';
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/** How an offer's next orders answer (S08, `supplier:fake --order`). */
export const fakeOrderScriptSchema = z.union([
  /**
   * S16 `resend-refused`: the first send buys and answers unknown; a re-send of its key is refused
   * (`INSUFFICIENT_BALANCE`), as WDGZone may (rule RS1).
   */
  z.enum(['delivered', 'pending', 'failed', 'invalid', 'unknown', 'resend-refused']),
  /** 1 to 50 units. */
  z
    .templateLiteral(['partial:', z.int()])
    .refine((value) => /^partial:([1-9]|[1-4]\d|50)$/.test(value)),
  /** 1 to 600 seconds. */
  z
    .templateLiteral(['slow:', z.int()])
    .refine((value) => /^slow:([1-9]\d{0,2})$/.test(value) && Number(value.slice(5)) <= 600),
]);

export type FakeOrderScript = z.infer<typeof fakeOrderScriptSchema>;

const outcomeSchema: z.ZodType<SupplierOutcome> = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('delivered'),
    supplierOrderId: z.string(),
    quantity: z.int().positive(),
    codes: z.array(z.string()).optional(),
  }),
  z.object({ status: z.literal('pending'), supplierOrderId: z.string() }),
  z.object({
    status: z.literal('failed_definitive'),
    supplierOrderId: z.string().optional(),
    supplierCode: z.string().optional(),
    inputRejected: z.boolean().optional(),
    reason: z.string(),
  }),
  z.object({
    status: z.literal('unknown'),
    supplierOrderId: z.string().optional(),
    reason: z.string(),
  }),
]);

/** A placed order: the request, its answer, and what polling finds once it settles. */
const fakeOrderSchema = z.object({
  request: z.object({
    idempotencyKey: z.string(),
    offerId: z.string(),
    quantity: z.int().positive(),
    fields: z.record(z.string(), z.string()),
  }),
  outcome: outcomeSchema,
  settled: outcomeSchema,
  /** S16: a re-send of this key is refused (the `resend-refused` script). */
  refuseResend: z.boolean().optional(),
  /** S16 SF3: when it was placed, for the statement. */
  placedAt: z.iso.datetime().optional(),
});

export type FakeOrder = z.infer<typeof fakeOrderSchema>;

/** What the `supplier:fake` CLI scripts (S07): changes to the catalog and to the calls. */
export const fakeSupplierStateSchema = z.object({
  /** Offer id → cost in USD units. */
  costs: z.record(z.string(), z.int().min(1).max(Number.MAX_SAFE_INTEGER)).default({}),
  outOfStock: z.array(z.string()).default([]),
  /** Offers left out of the list (and refused when ordered). */
  removed: z.array(z.string()).default([]),
  /** `listOffers` fails; the other calls answer. */
  failSync: z.boolean().default(false),
  /** Every catalog, balance and validation call fails, as a supplier that is down. */
  errors: z.boolean().default(false),
  balanceUsdUnits: z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  /** S08: offer id → how its next orders answer. */
  orderScripts: z.record(z.string(), fakeOrderScriptSchema).default({}),
  /** S08: the orders placed so far, by idempotency key. */
  orders: z.record(z.string(), fakeOrderSchema).default({}),
  /** S16 SF2: offer id → units in stock (0 is out of stock), or null for unlimited. */
  stockCounts: z.record(z.string(), z.int().min(0).max(1_000_000).nullable()).default({}),
  /** S16 SC2: categories left out of the tree. */
  missingCategories: z.array(z.string()).default([]),
  /** S16 SC11: offers added under a category of the tree. */
  addedOffers: z
    .array(
      z.object({
        offerId: z.string().regex(/^fake-added-\d{1,6}$/),
        categoryId: z.string().min(1).max(64),
        name: z.string().min(1).max(100),
        costUsdUnits: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .default([]),
});

export type FakeSupplierState = z.infer<typeof fakeSupplierStateSchema>;

export interface FakeAdapterOptions {
  webhookSecret: string;
  /**
   * Prepaid balance in USD units; an order costing more is refused. Default: the state's, else
   * 1,000 USD.
   */
  balanceUsdUnits?: number;
  /** The scripted changes (S07); none by default. */
  state?: FakeSupplierState;
  /** Delay of `slow…` orders. Default 3 seconds. */
  slowMs?: number;
  /** Called with every new or changed order, for the caller to keep (S08). */
  onOrder?: (idempotencyKey: string, order: FakeOrder) => Promise<void>;
}

/** What an order keeps of its request (a re-send's flag is not part of it). */
const requestOf = (request: PlaceOrderRequest): FakeOrder['request'] => ({
  idempotencyKey: request.idempotencyKey,
  offerId: request.offerId,
  quantity: request.quantity,
  fields: request.fields,
});

const usd = (cents: number): SupplierMoney => ({ currency: 'USD', amountUnits: cents * USD_CENT });

type FakeOffer = SupplierOffer & { delivers: 'topup' | 'code' };

const PLAYER_FIELD: FieldSpec = { key: 'playerId', label: 'Player ID', type: 'text' };

const topUp = (
  offerId: string,
  name: string,
  group: string,
  cents: number,
  categoryId: string,
  originalCents?: number,
): FakeOffer => ({
  offerId,
  name,
  cost: usd(cents),
  inStock: true,
  group,
  kind: 'direct',
  requiredFields: ['playerId'],
  categoryId,
  ...(originalCents !== undefined && { originalCost: usd(originalCents) }),
  fieldSpecs: [PLAYER_FIELD],
  delivers: 'topup',
});

const giftCard = (offerId: string, name: string, cents: number): FakeOffer => ({
  offerId,
  name,
  cost: usd(cents),
  inStock: true,
  group: 'iTunes',
  kind: 'code',
  requiredFields: [],
  categoryId: 'fake-itunes',
  stock: 40,
  fieldSpecs: [],
  delivers: 'code',
});

/** S16 MF1: a second text field, as Mobile Legends asks for. */
const ZONE_FIELD: FieldSpec = { key: 'zoneId', label: 'Zone ID', type: 'text' };

/** S16 MF2: a select whose values differ from their labels, as Genshin Impact's servers. */
const REGION_FIELD: FieldSpec = {
  key: 'region',
  label: 'Region',
  type: 'select',
  options: [
    { label: 'America', value: 'os_usa' },
    { label: 'Europe', value: 'os_euro' },
    { label: 'Asia', value: 'os_asia' },
    { label: 'TW, HK, MO', value: 'os_cht' },
  ],
};

/** A top-up with more fields than the player's (S16 MF1, MF2). */
const withFields = (offer: FakeOffer, extra: FieldSpec): FakeOffer => ({
  ...offer,
  requiredFields: ['playerId', extra.key],
  fieldSpecs: [PLAYER_FIELD, extra],
});

/**
 * The fake catalog: PUBG Mobile and Free Fire top-ups, iTunes codes, and (S16 PR 4) Mobile Legends
 * with a zone and Genshin Impact with a region select.
 */
const OFFERS: readonly FakeOffer[] = [
  topUp('fake-uc-60', 'Fake UC 60', 'PUBG Mobile', 88, 'fake-pubg-global', 99),
  topUp('fake-uc-325', 'Fake UC 325', 'PUBG Mobile', 440, 'fake-pubg-global', 499),
  topUp('fake-uc-660', 'Fake UC 660', 'PUBG Mobile', 870, 'fake-pubg-mena'),
  topUp('fake-uc-1800', 'Fake UC 1800', 'PUBG Mobile', 2_190, 'fake-pubg-mena'),
  topUp('fake-ff-100', 'Fake Free Fire 100', 'Free Fire', 95, 'fake-ff-auto'),
  topUp('fake-ff-310', 'Fake Free Fire 310', 'Free Fire', 290, 'fake-ff-auto'),
  topUp('fake-ff-520', 'Fake Free Fire 520', 'Free Fire', 480, 'fake-ff-auto'),
  topUp('fake-ff-1060', 'Fake Free Fire 1060', 'Free Fire', 950, 'fake-ff-auto'),
  giftCard('fake-gift-10', 'Fake gift card 10', 960),
  giftCard('fake-itunes-25', 'Fake iTunes 25', 2_400),
  withFields(topUp('fake-ml-86', 'Fake Diamonds 86', 'Mobile Legends', 140, 'fake-ml'), ZONE_FIELD),
  withFields(
    topUp('fake-ml-172', 'Fake Diamonds 172', 'Mobile Legends', 275, 'fake-ml'),
    ZONE_FIELD,
  ),
  withFields(
    topUp('fake-gi-60', 'Fake Genesis Crystals 60', 'Genshin Impact', 85, 'fake-gi'),
    REGION_FIELD,
  ),
  withFields(
    topUp('fake-gi-330', 'Fake Genesis Crystals 330', 'Genshin Impact', 420, 'fake-gi'),
    REGION_FIELD,
  ),
];

/** The host of the fake's category images (rule IM1); `.invalid` never resolves. */
export const FAKE_IMAGE_HOST = 'fake-supplier.invalid';

const imageUrl = (categoryId: string) => `https://${FAKE_IMAGE_HOST}/images/${categoryId}.png`;

/** The fake category tree (S16 SC1), each with the color of its bundled image. */
const CATEGORIES: readonly (SupplierCategory & { color: [number, number, number] })[] = [
  { categoryId: 'fake-pubg', name: 'PUBG Mobile', kind: 'direct', color: [214, 160, 40] },
  {
    categoryId: 'fake-pubg-global',
    parentCategoryId: 'fake-pubg',
    name: 'Global',
    kind: 'direct',
    color: [190, 140, 30],
  },
  {
    categoryId: 'fake-pubg-mena',
    parentCategoryId: 'fake-pubg',
    name: 'MENA',
    kind: 'direct',
    color: [170, 120, 20],
  },
  { categoryId: 'fake-ff', name: 'Free Fire', kind: 'direct', color: [220, 80, 40] },
  {
    categoryId: 'fake-ff-auto',
    parentCategoryId: 'fake-ff',
    name: 'Auto',
    kind: 'direct',
    color: [200, 60, 30],
  },
  { categoryId: 'fake-gift', name: 'Gift cards', kind: 'code', color: [60, 120, 200] },
  {
    categoryId: 'fake-itunes',
    parentCategoryId: 'fake-gift',
    name: 'iTunes',
    kind: 'code',
    color: [40, 100, 180],
  },
  { categoryId: 'fake-ml', name: 'Mobile Legends', kind: 'direct', color: [90, 60, 180] },
  { categoryId: 'fake-gi', name: 'Genshin Impact', kind: 'direct', color: [60, 170, 160] },
];

/** A solid 64×64 PNG, so the fake needs no image files (rule IM1's bundled images). */
function solidPng([red, green, blue]: [number, number, number]): Uint8Array {
  const size = 64;
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) row.set([red, green, blue], 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const STATEMENT_PAGE_SIZE = 50;

const webhookBodySchema = z.object({
  eventId: z.string().min(1),
  /** Left out, the order is named by `supplierOrderId` alone, as WDGZone's webhooks do. */
  idempotencyKey: z.string().min(1).optional(),
  supplierOrderId: z.string().min(1),
  status: z.enum(['delivered', 'failed']),
  /** The units delivered (S08). */
  quantity: z.int().positive().optional(),
  codes: z.array(z.string()).optional(),
});

/** A delivery of `units`, with one generated code per unit for a code offer. */
function deliveredOutcome(
  delivers: FakeOffer['delivers'],
  supplierOrderId: string,
  units: number,
): SupplierOutcome {
  return {
    status: 'delivered',
    supplierOrderId,
    quantity: units,
    ...(delivers === 'code' && {
      codes: Array.from(
        { length: units },
        () => `FAKE-${randomBytes(6).toString('hex').toUpperCase()}`,
      ),
    }),
  };
}

const sameRequest = (a: PlaceOrderRequest, b: PlaceOrderRequest) =>
  a.offerId === b.offerId &&
  a.quantity === b.quantity &&
  JSON.stringify(Object.entries(a.fields).sort()) ===
    JSON.stringify(Object.entries(b.fields).sort());

export class FakeSupplierAdapter implements SupplierAdapter {
  readonly code = FAKE_SUPPLIER_CODE;
  readonly capabilities: SupplierCapabilities = {
    validatePlayer: true,
    webhooks: true,
    balance: true,
    catalog: true,
    categories: true,
    statement: true,
    platformStatus: true,
  };

  readonly imageHosts: readonly string[] = [FAKE_IMAGE_HOST];

  private readonly orders: Map<string, FakeOrder>;
  private readonly state: FakeSupplierState;
  private balanceUnits: number;

  constructor(private readonly options: FakeAdapterOptions) {
    this.state = options.state ?? fakeSupplierStateSchema.parse({});
    this.orders = new Map(Object.entries(this.state.orders));
    this.balanceUnits =
      options.balanceUsdUnits ?? this.state.balanceUsdUnits ?? 1_000 * 100 * USD_CENT;
  }

  async listOffers(): Promise<SupplierOffer[]> {
    this.failIfScripted();
    if (this.state.failSync) throw new SupplierError('retryable', 'Fake catalog unavailable');
    return this.catalog().map(({ delivers: _, ...offer }) => offer);
  }

  async getBalance(): Promise<SupplierMoney> {
    this.failIfScripted();
    return { currency: 'USD', amountUnits: this.balanceUnits };
  }

  /** S16 SC1: the tree without the categories scripted missing. */
  async listCategories(): Promise<SupplierCategory[]> {
    this.failIfScripted();
    const offers = this.catalog();
    return CATEGORIES.filter(
      (category) => !this.state.missingCategories.includes(category.categoryId),
    ).map(({ color: _, ...category }) => {
      const under = offers.filter(
        (offer) =>
          offer.categoryId === category.categoryId ||
          CATEGORIES.some(
            (child) =>
              child.parentCategoryId === category.categoryId &&
              child.categoryId === offer.categoryId,
          ),
      );
      return {
        ...category,
        productCount: under.length,
        inStockCount: under.filter((offer) => offer.inStock).length,
        imageUrl: imageUrl(category.categoryId),
      };
    });
  }

  /** S16 SF3: one purchase per order it took, newest first. */
  async listTransactions(page: number): Promise<SupplierStatementPage<SupplierTransactionRow>> {
    this.failIfScripted();
    const { items, hasMore } = this.statementPage(page);
    return {
      items: items.map((row) => ({
        id: `txn-${row.supplierOrderId}`,
        type: 'purchase',
        ...(row.total && {
          amount: { currency: 'USD' as const, amountUnits: -row.total.amountUnits },
        }),
        reference: `Order ${row.supplierOrderId}`,
        supplierOrderId: row.supplierOrderId,
        ...(row.createdAt && { createdAt: row.createdAt }),
      })),
      hasMore,
    };
  }

  /** S16 SF3: the orders it took (those with an order id), newest first. */
  async listOrders(page: number): Promise<SupplierStatementPage<SupplierOrderRow>> {
    this.failIfScripted();
    return this.statementPage(page);
  }

  /** S16 SF5: down while every call fails (`--errors on`). */
  async getPlatformStatus(): Promise<SupplierPlatformStatus> {
    return {
      status: this.state.errors ? 'maintenance' : 'operational',
      catalogUpdatedAt: new Date(),
    };
  }

  /** S16 IM1: the bundled image of a category on the fake's host; nothing leaves the machine. */
  async fetchImage(url: string, _limits: ImageLimits): Promise<Uint8Array> {
    const category = CATEGORIES.find((item) => imageUrl(item.categoryId) === url);
    if (!imageUrlAllowed(url, this.imageHosts) || !category) {
      throw new SupplierError('definitive', 'No such fake image', {
        supplierCode: 'IMAGE_FETCH_FAILED',
        status: 404,
      });
    }
    return solidPng(category.color);
  }

  async validatePlayer(input: { offerId: string; fields: OrderFields }): Promise<PlayerValidation> {
    this.failIfScripted();
    const playerId = input.fields.playerId;
    if (!playerId) throw new SupplierError('definitive', 'playerId is required');
    if (playerId.startsWith('invalid')) return { valid: false };
    return { valid: true, playerName: `Player ${playerId.slice(-4)}` };
  }

  async placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome> {
    const existing = this.orders.get(request.idempotencyKey);
    if (existing) {
      // A supplier answers a repeated key with that order's current outcome, never a second
      // purchase; an order whose answer was lost is found as it really ended (S08 rule F3).
      if (!sameRequest(existing.request, request)) {
        return {
          status: 'failed_definitive',
          supplierCode: 'IDEMPOTENCY_KEY_REUSED',
          reason: 'Key reused for another order',
        };
      }
      if (existing.refuseResend) {
        return {
          status: 'failed_definitive',
          supplierCode: 'INSUFFICIENT_BALANCE',
          reason: 'Supplier balance too low',
        };
      }
      return existing.outcome.status === 'unknown' ? existing.settled : existing.outcome;
    }
    const offer = this.catalog().find((candidate) => candidate.offerId === request.offerId);
    const playerId = request.fields.playerId ?? '';
    const script: FakeOrderScript | null = offer
      ? (this.state.orderScripts[offer.offerId] ?? null)
      : null;
    const as = (prefix: string, scripted: FakeOrderScript) =>
      script === null ? playerId.startsWith(prefix) : script === scripted;
    if (
      !offer ||
      (offer.delivers === 'topup' && !playerId) ||
      (script === null && playerId.startsWith('fail')) ||
      script === 'failed'
    ) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'FAKE_REFUSED',
        reason: offer ? 'Refused by the fake supplier' : 'Unknown offer',
      });
    }
    // S16 MF1, MF2: every field of the offer, and a select's value from its own list.
    const fieldRefused = (offer.fieldSpecs ?? []).some((spec) => {
      const value = request.fields[spec.key];
      if (!value) return true;
      return spec.type === 'select' && !spec.options?.some((option) => option.value === value);
    });
    if (fieldRefused) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'FIELD_REFUSED',
        reason: 'A field is missing or not one of its options',
      });
    }
    if (as('invalid', 'invalid')) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'PLAYER_NOT_FOUND',
        inputRejected: true,
        reason: 'Player not found at the fake supplier',
      });
    }
    if (!offer.inStock) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'OUT_OF_STOCK',
        reason: 'Out of stock at the fake supplier',
      });
    }
    const units = script?.startsWith('partial:')
      ? Math.min(request.quantity, Number(script.slice('partial:'.length)))
      : request.quantity;
    const cost = offer.cost.amountUnits * units;
    if (cost > this.balanceUnits) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'INSUFFICIENT_BALANCE',
        reason: 'Supplier balance too low',
      });
    }
    this.balanceUnits -= cost;
    const supplierOrderId = `fake-${randomUUID()}`;
    const delivered = deliveredOutcome(offer.delivers, supplierOrderId, units);

    if (as('pending', 'pending') || (script === null && playerId.startsWith('badsig'))) {
      return this.record(request, { status: 'pending', supplierOrderId }, delivered);
    }
    if (script === 'resend-refused') {
      await this.keep(request.idempotencyKey, {
        request: requestOf(request),
        outcome: { status: 'unknown', reason: 'Fake supplier timed out' },
        settled: delivered,
        refuseResend: true,
      });
      return { status: 'unknown', reason: 'Fake supplier timed out' };
    }
    if (as('unknown', 'unknown')) {
      // A scripted `unknown` never answers until resolved (the hard limit, rule F7); the
      // `unknown…` player is found delivered by the first poll.
      return this.record(
        request,
        { status: 'unknown', reason: 'Fake supplier timed out' },
        script === 'unknown'
          ? { status: 'unknown', reason: 'Fake supplier has no answer' }
          : delivered,
      );
    }
    // Recorded before the delay, as a supplier that took the order and answers late.
    const recorded = await this.record(request, delivered);
    const slowMs = script?.startsWith('slow:')
      ? Number(script.slice('slow:'.length)) * 1_000
      : script === null && playerId.startsWith('slow')
        ? (this.options.slowMs ?? 3_000)
        : 0;
    if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
    return recorded;
  }

  async getOrder(idempotencyKey: string): Promise<SupplierOutcome> {
    const order = this.orders.get(idempotencyKey);
    if (!order) return { status: 'unknown', reason: 'No order with this key' };
    // Polling an unknown outcome finds what really happened; a pending one waits its webhook.
    return order.outcome.status === 'unknown' ? order.settled : order.outcome;
  }

  /**
   * Settles a pending order as delivered and returns the webhook the supplier would send, signed
   * (or, for `badsig…` orders, signed wrongly). For tests, development and E2E.
   */
  async completePending(idempotencyKey: string, now = new Date()): Promise<WebhookRequest> {
    if (this.orders.get(idempotencyKey)?.outcome.status !== 'pending') {
      throw new Error('No pending fake order with this key');
    }
    return this.resolve(idempotencyKey, 'delivered', now);
  }

  /**
   * S08 `supplier:fake --resolve`: settles a pending or unknown order as delivered or failed, so
   * the next poll finds it, and returns the signed webhook that reports it.
   */
  async resolve(
    idempotencyKey: string,
    status: 'delivered' | 'failed',
    now = new Date(),
  ): Promise<WebhookRequest> {
    const order = this.orders.get(idempotencyKey);
    const open = order?.outcome.status === 'pending' || order?.outcome.status === 'unknown';
    if (!order || !open) throw new Error('No open fake order with this key');
    const supplierOrderId =
      ('supplierOrderId' in order.outcome && order.outcome.supplierOrderId) ||
      `fake-${randomUUID()}`;
    const delivers =
      this.catalog().find((offer) => offer.offerId === order.request.offerId)?.delivers ?? 'topup';
    const result: SupplierOutcome =
      status === 'failed'
        ? { status: 'failed_definitive', supplierOrderId, reason: 'Failed by the fake supplier' }
        : order.settled.status === 'delivered'
          ? order.settled
          : deliveredOutcome(delivers, supplierOrderId, order.request.quantity);
    await this.keep(idempotencyKey, { ...order, outcome: result, settled: result });
    const rawBody = JSON.stringify({
      eventId: `evt-${randomUUID()}`,
      idempotencyKey,
      supplierOrderId,
      status,
      ...(result.status === 'delivered' && {
        quantity: result.quantity,
        ...(result.codes && { codes: result.codes }),
      }),
    });
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const secret = order.request.fields.playerId?.startsWith('badsig')
      ? 'not-the-secret'
      : this.options.webhookSecret;
    return {
      headers: {
        [FAKE_TIMESTAMP_HEADER]: timestamp,
        [FAKE_SIGNATURE_HEADER]: hmacSha256(secret, `${timestamp}.${rawBody}`),
      },
      rawBody,
    };
  }

  verifyWebhook(request: WebhookRequest, now?: Date): boolean {
    const timestamp = request.headers[FAKE_TIMESTAMP_HEADER];
    if (!timestamp || !/^\d+$/.test(timestamp)) return false;
    return verifyHmacSignature({
      secret: this.options.webhookSecret,
      signedPayload: `${timestamp}.${request.rawBody}`,
      signature: request.headers[FAKE_SIGNATURE_HEADER],
      timestamp: Number(timestamp),
      ...(now && { now }),
    });
  }

  parseWebhook(request: WebhookRequest): SupplierWebhookEvent {
    let parsed: z.infer<typeof webhookBodySchema>;
    try {
      parsed = webhookBodySchema.parse(JSON.parse(request.rawBody));
    } catch (cause) {
      throw new SupplierError('definitive', 'Malformed fake webhook', { cause });
    }
    const outcome: SupplierOutcome =
      parsed.status === 'delivered'
        ? {
            status: 'delivered',
            supplierOrderId: parsed.supplierOrderId,
            quantity: parsed.quantity ?? parsed.codes?.length ?? 1,
            ...(parsed.codes && { codes: parsed.codes }),
          }
        : {
            status: 'failed_definitive',
            supplierOrderId: parsed.supplierOrderId,
            reason: 'Failed by the fake supplier',
          };
    return {
      eventId: parsed.eventId,
      ...(parsed.idempotencyKey !== undefined && { idempotencyKey: parsed.idempotencyKey }),
      supplierOrderId: parsed.supplierOrderId,
      outcome,
    };
  }

  /** The catalog with the scripted costs, stock, removals and added offers. */
  private catalog(): FakeOffer[] {
    const { costs, outOfStock, removed, stockCounts } = this.state;
    const added = this.state.addedOffers.flatMap((added): FakeOffer[] => {
      const category = CATEGORIES.find((item) => item.categoryId === added.categoryId);
      if (!category) return [];
      const root =
        CATEGORIES.find((item) => item.categoryId === category.parentCategoryId) ?? category;
      const kind: ProductKind = category.kind ?? 'direct';
      const offer =
        kind === 'code'
          ? giftCard(added.offerId, added.name, 1)
          : topUp(added.offerId, added.name, root.name, 1, added.categoryId);
      return [
        {
          ...offer,
          group: root.name,
          categoryId: added.categoryId,
          cost: { currency: 'USD', amountUnits: added.costUsdUnits },
        },
      ];
    });
    return [...OFFERS, ...added]
      .filter((offer) => !removed.includes(offer.offerId))
      .map(({ stock: listed, ...offer }) => {
        const count = Object.hasOwn(stockCounts, offer.offerId)
          ? stockCounts[offer.offerId]
          : listed;
        return {
          ...offer,
          cost: { currency: 'USD', amountUnits: costs[offer.offerId] ?? offer.cost.amountUnits },
          inStock: !outOfStock.includes(offer.offerId) && count !== 0,
          ...(count !== null && count !== undefined && { stock: count }),
        };
      });
  }

  /** The orders with a supplier order id, newest first, a page of 50. */
  private statementPage(page: number): SupplierStatementPage<SupplierOrderRow> {
    const catalog = this.catalog();
    const rows = [...this.orders.values()]
      .flatMap((order): SupplierOrderRow[] => {
        const placed = [order.outcome, order.settled].find(
          (outcome) => 'supplierOrderId' in outcome && outcome.supplierOrderId,
        );
        const supplierOrderId =
          placed && 'supplierOrderId' in placed ? placed.supplierOrderId : undefined;
        if (!supplierOrderId) return [];
        const offer = catalog.find((item) => item.offerId === order.request.offerId);
        return [
          {
            supplierOrderId,
            offerId: order.request.offerId,
            ...(offer && {
              offerName: offer.name,
              total: {
                currency: 'USD' as const,
                amountUnits: offer.cost.amountUnits * order.request.quantity,
              },
            }),
            quantity: order.request.quantity,
            status: order.settled.status,
            ...(order.placedAt && { createdAt: new Date(order.placedAt) }),
          },
        ];
      })
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    const start = (page - 1) * STATEMENT_PAGE_SIZE;
    return {
      items: rows.slice(start, start + STATEMENT_PAGE_SIZE),
      hasMore: rows.length > start + STATEMENT_PAGE_SIZE,
    };
  }

  /** A supplier that is down: no answer (S07 acceptance, `--errors on`). */
  private failIfScripted(): void {
    if (this.state.errors) throw new SupplierError('retryable', 'Fake supplier timed out');
  }

  private async record(
    request: PlaceOrderRequest,
    outcome: SupplierOutcome,
    settled: SupplierOutcome = outcome,
  ): Promise<SupplierOutcome> {
    await this.keep(request.idempotencyKey, { request: requestOf(request), outcome, settled });
    return outcome;
  }

  private async keep(idempotencyKey: string, update: FakeOrder): Promise<void> {
    const placedAt =
      update.placedAt ?? this.orders.get(idempotencyKey)?.placedAt ?? new Date().toISOString();
    const order = { ...update, placedAt };
    this.orders.set(idempotencyKey, order);
    await this.options.onOrder?.(idempotencyKey, order);
  }
}
