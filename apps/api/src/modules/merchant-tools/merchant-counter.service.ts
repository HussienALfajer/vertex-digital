import { Inject, Injectable } from '@nestjs/common';
import {
  BULK_LINES_MAX,
  type BulkCheckLine,
  type BulkCheckRequest,
  type BulkCheckResult,
  bulkNeedsConfirmation,
  canonicalFields,
  checkoutTotal,
  type OrderSale,
  orderQuantityMax,
  orderTotal,
  type PlayerCheck,
  type PlayerCheckRequest,
  parseBulkLines,
  type ReceiptSettings,
  type RecentPlayers,
  type SellingPriceInput,
  type UpdateReceiptSettings,
  type UploadedLogo,
} from '@vertex-digital/contracts';
import {
  accountBalance,
  bulkGame,
  checkOrderFields,
  type Database,
  findCustomerWallet,
  lockActiveCustomer,
  merchantEarlyAccess,
  merchantListPrices,
  merchantPrivileges,
  OrderError,
  ownOrderForSale,
  receiptSettingsOf,
  recentPlayers,
  requireMerchantTerms,
  saveReceiptSettings,
  setMerchantLogo,
  setOrderSale,
  shownGames,
  withinLimits,
} from '@vertex-digital/db';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { PlayerChecksService } from '../orders/index.js';
import { refusals, requireMerchant } from './merchant-access.js';

const HOUR = 60 * 60 * 1000;

/** A06-32: the bulk check's player checks run this many at a time, through the pool. */
const BULK_CHECKS_AT_ONCE = 5;

/** A06-32: no player check starts this long after the bulk check began (each takes 5 s at most). */
const BULK_CHECK_BUDGET_MS = 30_000;

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/**
 * The counter tools (S21 F32–F35): recent player ids (PS2), the bulk list's check (BK1–BK4),
 * the receipt settings and logo (BR3), and an order's selling price set later (SP5). Merchants
 * only; a frozen merchant reads but never writes. The merchant's own preferences are not audited.
 */
@Injectable()
export class MerchantCounterService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly files: FilesService,
    private readonly playerChecks: PlayerChecksService,
  ) {}

  /** `GET /api/merchant/recent-players?gameId` (PS2). */
  async recentPlayers(customerId: string, gameId: string): Promise<RecentPlayers> {
    await requireMerchant(this.db, customerId);
    const rows = await recentPlayers(this.db, customerId, gameId);
    return {
      items: rows.map((row) => ({
        fields: row.fields,
        playerName: row.playerName,
        lastUsedAt: row.lastUsedAt.toISOString(),
      })),
    };
  }

  /**
   * `POST /api/merchant/bulk/check` (BK2): every line parsed and checked on the merchant's list,
   * each distinct id checked once against the merchant's quota (BK4); nothing written but the
   * checks' cache. A merchant not frozen with the terms accepted; 30 checks an hour.
   */
  async bulkCheck(
    customerId: string,
    request: BulkCheckRequest,
    meta: RequestMeta,
  ): Promise<BulkCheckResult> {
    await requireMerchant(this.db, customerId, true);
    // S23 TS5: the tier's lines and code units, read with the customer.
    const tier = await this.db
      .transaction(async (tx) => {
        const customer = await lockActiveCustomer(tx, customerId);
        requireMerchantTerms(customer);
        return customer.tierQuantities;
      })
      .catch((error: unknown) => {
        if (error instanceof OrderError) {
          throw new CodedException(
            error.code === 'ACCOUNT_FROZEN' ? 403 : 409,
            error.code,
            error.message,
          );
        }
        throw error;
      });
    const allowed = await withinLimits(this.db, [
      { key: `bulk-check:customer:${customerId}`, max: 30, windowMs: HOUR },
    ]);
    if (!allowed) throw new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later');
    const earlyAccess = await merchantEarlyAccess(this.db, customerId);
    if (!(await shownGames(this.db, earlyAccess)).some((game) => game.id === request.gameId)) {
      throw refusals.notFound('game');
    }
    const game = await bulkGame(this.db, request.gameId);
    const parsed = parseBulkLines(request.text, game);
    const linesMax = tier?.bulkLinesMax ?? BULK_LINES_MAX;
    if (parsed.length === 0 || parsed.length > linesMax) {
      throw new CodedException(422, 'BULK_LINES_INVALID', `Expected 1 to ${linesMax} lines`, {
        lines: parsed.length,
        max: linesMax,
      });
    }
    const packs = new Map(game.packs.map((pack) => [pack.id, pack]));
    const prices = await merchantListPrices(
      this.db,
      customerId,
      game.packs.map((pack) => pack.id),
      routingContext(this.env),
    );
    const drafts: (Omit<BulkCheckLine, 'check' | 'needsConfirmation'> & { key: string | null })[] =
      [];
    // Edge case 9: the same id on several lines is checked once.
    const toCheck = new Map<string, PlayerCheckRequest>();
    for (const line of parsed) {
      const pack = line.productId ? packs.get(line.productId) : undefined;
      const unit = pack ? (prices.get(pack.id)?.priceUsdUnits ?? null) : null;
      const errors: BulkCheckLine['errors'] = line.errors.map((code) => ({ code, field: null }));
      let fields = line.fields;
      if (
        pack &&
        line.quantity !== null &&
        line.quantity > orderQuantityMax(pack, 'merchant', tier)
      ) {
        errors.push({ code: 'quantity_above_max', field: null });
      }
      if (pack && unit === null) errors.push({ code: 'pack_unavailable', field: null });
      if (pack && pack.kind === 'direct' && !line.errors.includes('columns')) {
        const checked = await this.db.transaction((tx) =>
          checkOrderFields(tx, request.gameId, line.fields),
        );
        if (checked.ok) fields = checked.fields;
        else {
          for (const field of Object.keys(checked.refusals)) {
            errors.push({ code: 'field_invalid', field });
          }
        }
      }
      let key: string | null = null;
      if (pack && errors.length === 0 && pack.kind === 'direct') {
        key = JSON.stringify(canonicalFields(fields));
        if (!toCheck.has(key)) toCheck.set(key, { productId: pack.id, fields });
      }
      const payable = pack !== undefined && unit !== null && errors.length === 0;
      drafts.push({
        line: line.line,
        fields: pack?.kind === 'code' ? {} : fields,
        product: pack ? { id: pack.id, nameAr: pack.nameAr } : null,
        quantity: line.quantity,
        unitPriceUsdUnits: unit,
        totalUsdUnits:
          payable && line.quantity !== null ? orderTotal(unit as number, line.quantity) : null,
        errors,
        key,
      });
    }
    const checks = await this.checkPlayers(customerId, toCheck, meta);
    const lines: BulkCheckLine[] = drafts.map(({ key, ...line }) => {
      const check = key === null ? null : (checks.get(key) ?? null);
      return { ...line, check, needsConfirmation: bulkNeedsConfirmation(check) };
    });
    const wallet = await findCustomerWallet(this.db, customerId);
    return {
      lines,
      totalUsdUnits: checkoutTotal(
        lines.flatMap((line) =>
          line.totalUsdUnits !== null && line.unitPriceUsdUnits !== null && line.quantity !== null
            ? [{ unitPriceUsdUnits: line.unitPriceUsdUnits, quantity: line.quantity }]
            : [],
        ),
      ),
      balanceUsdUnits: wallet === null ? 0 : await accountBalance(this.db, wallet),
    };
  }

  /**
   * BK2 (audit A06-32): the distinct ids of a bulk list checked through the pool, at most
   * `BULK_CHECKS_AT_ONCE` at a time, and none started once `bulkCheckBudgetMs` has passed: those
   * answer `unavailable` ("لم يُفحص") and spend no quota, so 50 new ids answer well within nginx's
   * 60 seconds (each check takes at most 5 s, PV6). A failing check stops new ones and fails the
   * request once the running ones end.
   */
  private async checkPlayers(
    customerId: string,
    requests: ReadonlyMap<string, PlayerCheckRequest>,
    meta: RequestMeta,
  ): Promise<Map<string, PlayerCheck>> {
    const deadline = Date.now() + this.bulkCheckBudgetMs();
    const queue = [...requests];
    const checks = new Map<string, PlayerCheck>();
    const failures: unknown[] = [];
    const worker = async () => {
      for (let next = queue.shift(); next && failures.length === 0; next = queue.shift()) {
        const [key, request] = next;
        if (Date.now() >= deadline) {
          checks.set(key, { result: 'unavailable', reason: 'supplier' });
          continue;
        }
        try {
          checks.set(key, await this.playerChecks.checkLine(customerId, request, meta));
        } catch (error) {
          failures.push(error);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BULK_CHECKS_AT_ONCE, queue.length) }, () => worker()),
    );
    if (failures.length > 0) throw failures[0];
    return checks;
  }

  /** The time after which a bulk check starts no player check (a method, so a test shortens it). */
  bulkCheckBudgetMs(): number {
    return BULK_CHECK_BUDGET_MS;
  }

  /**
   * `GET /api/merchant/receipt-settings` (BR3); S23 RC1: whether the tier prints a welcome line.
   */
  async receiptSettings(customerId: string): Promise<ReceiptSettings> {
    await requireMerchant(this.db, customerId);
    const settings = await receiptSettingsOf(this.db, customerId);
    if (!settings) throw refusals.notMerchant();
    return { ...settings, welcomeAllowed: await this.welcomeAllowed(customerId) };
  }

  private async welcomeAllowed(customerId: string): Promise<boolean> {
    return (await merchantPrivileges(this.db, customerId))?.settings.receiptWelcome ?? false;
  }

  /**
   * `PUT /api/merchant/receipt-settings` (BR3): a logo the merchant uploaded, or none. S23 RC1: a
   * new welcome line needs a tier that prints it; a kept or cleared one never does.
   */
  async saveReceiptSettings(
    customerId: string,
    input: UpdateReceiptSettings,
  ): Promise<ReceiptSettings> {
    await requireMerchant(this.db, customerId, true);
    // The logo is kept or removed here; a new one arrives through the upload.
    if (input.logoFileId !== null && !(await this.ownLogo(customerId, input.logoFileId))) {
      throw refusals.invalid('logoFileId', 'Not the logo of this merchant');
    }
    if (input.welcomeText !== null && !(await this.welcomeAllowed(customerId))) {
      const saved = await receiptSettingsOf(this.db, customerId);
      if (saved?.welcomeText !== input.welcomeText) {
        throw refusals.invalid('welcomeText', 'The tier prints no welcome line');
      }
    }
    await saveReceiptSettings(this.db, customerId, input);
    return this.receiptSettings(customerId);
  }

  /**
   * `POST /api/merchant/logo` (BR3): stored as a `merchant_logo` and made the merchant's logo at
   * once (its only owner record); 10 an hour.
   */
  async uploadLogo(customerId: string, upload: Buffer | undefined): Promise<UploadedLogo> {
    await requireMerchant(this.db, customerId, true);
    const allowed = await withinLimits(this.db, [
      { key: `merchant-logo:customer:${customerId}`, max: 10, windowMs: HOUR },
    ]);
    if (!allowed) throw new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later');
    if (!(await receiptSettingsOf(this.db, customerId))) throw refusals.notMerchant();
    const prepared = await this.files.prepare('merchant_logo', upload);
    const fileId = await this.db.transaction(async (tx) => {
      const id = await this.files.record(tx, prepared);
      // A06-39: only the logo changes; a WhatsApp saved meanwhile is kept.
      if (!(await setMerchantLogo(tx, customerId, id))) throw refusals.notMerchant();
      return id;
    });
    return { fileId };
  }

  /** `GET /api/merchant/logo/:fileId`: the merchant's own logo. */
  async logo(customerId: string, fileId: string): Promise<ServedFile> {
    await requireMerchant(this.db, customerId);
    const file =
      isUuid(fileId) && (await this.ownLogo(customerId, fileId))
        ? await this.files.serve(fileId, 'merchant_logo')
        : null;
    if (!file) throw refusals.notFound('logo');
    return file;
  }

  /**
   * `PUT /api/orders/:id/sale` (SP5): the merchant's own order (paid while a merchant, A06-36),
   * at the order's rate, and the $10,000 limit at that rate too (A06-35).
   */
  async setSale(customerId: string, orderId: string, input: SellingPriceInput): Promise<OrderSale> {
    await requireMerchant(this.db, customerId, true);
    const order = isUuid(orderId) ? await ownOrderForSale(this.db, customerId, orderId) : null;
    if (!order) throw refusals.notFound('order');
    const result = await this.db.transaction((tx) => setOrderSale(tx, order, input));
    if (!result.ok) {
      // A06-41: each refusal names its own cause.
      throw result.reason === 'too_high'
        ? refusals.invalid('amountUnits', "Above $10,000 at the order's rate")
        : refusals.invalid('currency', 'The order has no exchange rate to convert a SYP price at');
    }
    const { sale } = result;
    return {
      currency: sale.currency,
      unitAmountUnits: sale.unitAmountUnits,
      unitUsdUnits: sale.unitUsdUnits,
      source: sale.source,
    };
  }

  /** The merchant's logo now: an upload is the logo from the moment it is stored. */
  private async ownLogo(customerId: string, fileId: string): Promise<boolean> {
    return (await receiptSettingsOf(this.db, customerId))?.logoFileId === fileId;
  }
}
