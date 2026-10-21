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
  parseBulkLines,
  type ReceiptSettings,
  type RecentPlayers,
  type SellingPriceInput,
  sellingPriceTooHigh,
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
  merchantListPrices,
  OrderError,
  ownOrderForSale,
  receiptSettingsOf,
  recentPlayers,
  requireMerchantTerms,
  saveReceiptSettings,
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
import { RatesService } from '../rates/index.js';
import { refusals, requireMerchant } from './merchant-access.js';

const HOUR = 60 * 60 * 1000;

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
    private readonly rates: RatesService,
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
    await this.db
      .transaction(async (tx) => requireMerchantTerms(await lockActiveCustomer(tx, customerId)))
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
    if (!(await shownGames(this.db)).some((game) => game.id === request.gameId)) {
      throw refusals.notFound('game');
    }
    const game = await bulkGame(this.db, request.gameId);
    const parsed = parseBulkLines(request.text, game);
    if (parsed.length === 0 || parsed.length > BULK_LINES_MAX) {
      throw new CodedException(422, 'BULK_LINES_INVALID', 'Expected 1 to 50 lines', {
        lines: parsed.length,
        max: BULK_LINES_MAX,
      });
    }
    const packs = new Map(game.packs.map((pack) => [pack.id, pack]));
    const prices = await merchantListPrices(
      this.db,
      customerId,
      game.packs.map((pack) => pack.id),
      routingContext(this.env),
    );
    const checks = new Map<string, PlayerCheck>();
    const lines: BulkCheckLine[] = [];
    for (const line of parsed) {
      const pack = line.productId ? packs.get(line.productId) : undefined;
      const unit = pack ? (prices.get(pack.id)?.priceUsdUnits ?? null) : null;
      const errors: BulkCheckLine['errors'] = line.errors.map((code) => ({ code, field: null }));
      let fields = line.fields;
      if (pack && line.quantity !== null && line.quantity > orderQuantityMax(pack, 'merchant')) {
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
      let check: PlayerCheck | null = null;
      if (pack && errors.length === 0 && pack.kind === 'direct') {
        // Edge case 9: the same id on several lines is checked once.
        const key = JSON.stringify(canonicalFields(fields));
        check =
          checks.get(key) ??
          (await this.playerChecks.checkLine(customerId, { productId: pack.id, fields }, meta));
        checks.set(key, check);
      }
      const payable = pack !== undefined && unit !== null && errors.length === 0;
      lines.push({
        line: line.line,
        fields: pack?.kind === 'code' ? {} : fields,
        product: pack ? { id: pack.id, nameAr: pack.nameAr } : null,
        quantity: line.quantity,
        unitPriceUsdUnits: unit,
        totalUsdUnits:
          payable && line.quantity !== null ? orderTotal(unit as number, line.quantity) : null,
        check,
        needsConfirmation: bulkNeedsConfirmation(check),
        errors,
      });
    }
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

  /** `GET /api/merchant/receipt-settings` (BR3). */
  async receiptSettings(customerId: string): Promise<ReceiptSettings> {
    await requireMerchant(this.db, customerId);
    const settings = await receiptSettingsOf(this.db, customerId);
    if (!settings) throw refusals.notMerchant();
    return settings;
  }

  /** `PUT /api/merchant/receipt-settings` (BR3): a logo the merchant uploaded, or none. */
  async saveReceiptSettings(
    customerId: string,
    input: UpdateReceiptSettings,
  ): Promise<ReceiptSettings> {
    await requireMerchant(this.db, customerId, true);
    // The logo is kept or removed here; a new one arrives through the upload.
    if (input.logoFileId !== null && !(await this.ownLogo(customerId, input.logoFileId))) {
      throw refusals.invalid('logoFileId', 'Not the logo of this merchant');
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
    const current = await receiptSettingsOf(this.db, customerId);
    if (!current) throw refusals.notMerchant();
    const prepared = await this.files.prepare('merchant_logo', upload);
    const fileId = await this.db.transaction(async (tx) => {
      const id = await this.files.record(tx, prepared);
      await saveReceiptSettings(tx, customerId, {
        showWhatsapp: current.showWhatsapp,
        whatsapp: current.whatsapp,
        logoFileId: id,
      });
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

  /** `PUT /api/orders/:id/sale` (SP5): the merchant's own order, at the order's rate. */
  async setSale(customerId: string, orderId: string, input: SellingPriceInput): Promise<OrderSale> {
    await requireMerchant(this.db, customerId, true);
    const order = isUuid(orderId) ? await ownOrderForSale(this.db, customerId, orderId) : null;
    if (!order) throw refusals.notFound('order');
    if (input.currency === 'syp') {
      const rate = await this.rates.current();
      if (!rate || sellingPriceTooHigh(input, rate.sypPerUsd)) {
        throw refusals.invalid('amountUnits', 'Above $10,000 at the rate in force');
      }
    }
    const sale = await this.db.transaction((tx) => setOrderSale(tx, order, input));
    if (!sale) throw refusals.invalid('currency', 'No rate to convert a SYP price at');
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
