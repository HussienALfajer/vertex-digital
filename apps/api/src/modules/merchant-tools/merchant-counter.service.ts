import { Inject, Injectable } from '@nestjs/common';
import {
  type OrderSale,
  type ReceiptSettings,
  type RecentPlayers,
  type SellingPriceInput,
  type UpdateReceiptSettings,
  type UploadedLogo,
} from '@vertex-digital/contracts';
import {
  type Database,
  merchantPrivileges,
  ownOrderForSale,
  receiptSettingsOf,
  recentPlayers,
  saveReceiptSettings,
  setMerchantLogo,
  setOrderSale,
  withinLimits,
} from '@vertex-digital/db';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { refusals, requireMerchant } from './merchant-access.js';

const HOUR = 60 * 60 * 1000;

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/**
 * The counter tools (S21 F32, F34, F35): recent player ids (PS2), the receipt settings and logo
 * (BR3), and an order's selling price set later (SP5); bulk orders (F33) were removed by the owner
 * on 2026-10-30. Merchants only; a frozen merchant reads but never writes. The merchant's own
 * preferences are not audited.
 */
@Injectable()
export class MerchantCounterService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly files: FilesService,
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
