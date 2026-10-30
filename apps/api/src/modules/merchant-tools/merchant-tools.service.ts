import { Inject, Injectable } from '@nestjs/common';
import {
  type AlertSettings,
  DASHBOARD_TOP_PRODUCTS,
  damascusDayBounds,
  damascusMonth,
  type MerchantAlertPage,
  type MerchantAlertQuery,
  type MerchantDashboard,
  type MerchantDashboardQuery,
  type MerchantGames,
  monthRange,
  NO_ALERT_SETTINGS,
  type SellingPriceInput,
  type SellingPriceRow,
  type SellingPrices,
  type SellingSettings,
  sellingPrice,
  sellingPriceTooHigh,
  type UpdateWatches,
  WATCHES_MAX,
  type Watches,
  walletSypValue,
} from '@vertex-digital/contracts';
import {
  accountBalance,
  alertEvents,
  type Database,
  dashboardFacts,
  findCustomerWallet,
  gameProducts,
  liveGames,
  liveProducts,
  merchantAlertSettings,
  merchantEarlyAccess,
  merchantListPrices,
  merchantSellingPrices,
  merchantSellingSettings,
  merchantWatches,
  merchantWatchRows,
  netPurchases,
  recentGameUnits,
  sellingSettingsOf,
  shownGames,
  watchSuggestions,
} from '@vertex-digital/db';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { decodeCursor, encodeCursor } from '../../core/lists/cursor.js';
import { RatesService } from '../rates/index.js';
import { refusals, requireMerchant } from './merchant-access.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/**
 * The merchant area (S21 F30, F31, F37; MA1, MA2): the dashboard, the merchant's own selling
 * prices, follows and alert settings. Merchants only (`NOT_MERCHANT`); a frozen merchant reads
 * but never writes (`ACCOUNT_FROZEN`). Every amount is on the merchant's effective list, read as
 * the game page's private prices are. The merchant's own preferences are not audited.
 */
@Injectable()
export class MerchantToolsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly rates: RatesService,
  ) {}

  /** MA1: a merchant's account; `write` refuses a frozen one. */
  private merchant(customerId: string, write = false): Promise<void> {
    return requireMerchant(this.db, customerId, write);
  }

  /** `GET /api/merchant/dashboard` (DB1–DB6), read live. */
  async dashboard(customerId: string, query: MerchantDashboardQuery): Promise<MerchantDashboard> {
    await this.merchant(customerId);
    const now = new Date();
    const from =
      query.period === 'today'
        ? damascusDayBounds(now).todayStart
        : monthRange(damascusMonth(now)).start;
    const facts = await dashboardFacts(this.db, customerId, from, now, DASHBOARD_TOP_PRODUCTS);
    const wallet = await findCustomerWallet(this.db, customerId);
    const rate = await this.rates.current();
    return {
      period: query.period,
      from: from.toISOString(),
      salesUsdUnits: facts.salesUsdUnits,
      salesSypUnits: rate
        ? walletSypValue(facts.salesUsdUnits, rate.sypPerUsd, rate.displayStepSypUnits)
        : null,
      spendingUsdUnits: await netPurchases(this.db, customerId, from, now),
      profitUsdUnits: facts.profitUsdUnits,
      ordersWithoutSale: facts.ordersWithoutSale,
      balanceUsdUnits: wallet === null ? 0 : await accountBalance(this.db, wallet),
      topProducts: facts.topProducts,
      sellingConfigured: await this.sellingConfigured(customerId),
    };
  }

  private async sellingConfigured(customerId: string): Promise<boolean> {
    const settings = await sellingSettingsOf(this.db, customerId);
    if (settings.markupBp !== null) return true;
    const [own] = await this.db
      .select({ count: count() })
      .from(merchantSellingPrices)
      .where(eq(merchantSellingPrices.customerId, customerId));
    return (own?.count ?? 0) > 0;
  }

  /** `GET /api/merchant/games`: the store's games, for the merchant area's pickers. */
  async games(customerId: string): Promise<MerchantGames> {
    await this.merchant(customerId);
    const [games, units] = await Promise.all([
      shownGames(this.db, await merchantEarlyAccess(this.db, customerId)),
      recentGameUnits(this.db, customerId),
    ]);
    return { items: games.map((game) => ({ ...game, recentUnits: units.get(game.id) ?? 0 })) };
  }

  /** `GET /api/merchant/selling-settings` (SP1). */
  async sellingSettings(customerId: string): Promise<SellingSettings> {
    await this.merchant(customerId);
    return sellingSettingsOf(this.db, customerId);
  }

  /** `PUT /api/merchant/selling-settings` (SP1). */
  async saveSellingSettings(customerId: string, input: SellingSettings): Promise<SellingSettings> {
    await this.merchant(customerId, true);
    await this.db
      .insert(merchantSellingSettings)
      .values({ customerId, ...input })
      .onConflictDoUpdate({ target: merchantSellingSettings.customerId, set: input });
    return sellingSettingsOf(this.db, customerId);
  }

  /** `GET /api/merchant/selling-prices?gameId` (SP3): one row per unarchived pack of the game. */
  async sellingPrices(customerId: string, gameId: string): Promise<SellingPrices> {
    await this.merchant(customerId);
    const games = await shownGames(this.db, await merchantEarlyAccess(this.db, customerId));
    if (!games.some((game) => game.id === gameId)) throw refusals.notFound('game');
    return this.pricesOf(customerId, gameId);
  }

  private async pricesOf(
    customerId: string,
    gameId: string,
    only?: string,
  ): Promise<SellingPrices> {
    const { settings, storeStepUnits, rows } = await this.sellingRows(customerId, [gameId], only);
    return { settings, storeStepUnits, products: rows.map(({ gameId: _, ...row }) => row) };
  }

  /**
   * SP3: the selling price rows of the games' unarchived packs, in the store's order, on the
   * merchant's effective list (MA2); also the price list's source (PL1).
   */
  async sellingRows(
    customerId: string,
    gameIds: readonly string[],
    only?: string,
  ): Promise<{
    settings: SellingSettings;
    storeStepUnits: number;
    rate: string | null;
    rows: (SellingPriceRow & { gameId: string })[];
  }> {
    // S23 OP5: early-access packs only for a tier that sees them.
    const earlyAccess = await merchantEarlyAccess(this.db, customerId);
    const products = (await gameProducts(this.db, gameIds, earlyAccess)).filter(
      (product) => only === undefined || product.id === only,
    );
    const ids = products.map((product) => product.id);
    const [settings, prices, rate, own] = [
      await sellingSettingsOf(this.db, customerId),
      await merchantListPrices(this.db, customerId, ids, routingContext(this.env)),
      await this.rates.current(),
      ids.length === 0
        ? []
        : await this.db
            .select()
            .from(merchantSellingPrices)
            .where(
              and(
                eq(merchantSellingPrices.customerId, customerId),
                inArray(merchantSellingPrices.productId, ids),
              ),
            ),
    ];
    const ownOf = new Map(own.map((row) => [row.productId, row]));
    const storeStepUnits = rate?.displayStepSypUnits ?? 1;
    return {
      settings,
      storeStepUnits,
      rate: rate?.sypPerUsd ?? null,
      rows: products.map((product) => {
        const purchase = prices.get(product.id)?.priceUsdUnits ?? null;
        const ownRow = ownOf.get(product.id);
        const ownPrice: SellingPriceInput | null = ownRow
          ? ({ currency: ownRow.currency, amountUnits: ownRow.amountUnits } as SellingPriceInput)
          : null;
        const selling = sellingPrice(
          purchase,
          settings,
          ownPrice,
          rate?.sypPerUsd ?? null,
          storeStepUnits,
        );
        return {
          gameId: product.gameId,
          productId: product.id,
          nameAr: product.nameAr,
          available: purchase !== null,
          purchaseUsdUnits: purchase,
          ownPrice,
          sellingUsdUnits: selling?.usdUnits ?? null,
          sellingSypUnits: selling?.sypUnits ?? null,
          source: selling?.source ?? 'none',
          belowCost: selling !== null && purchase !== null && selling.usdUnits < purchase,
        };
      }),
    };
  }

  /** `PUT /api/merchant/selling-prices/:productId` (SP2): at most $10,000 at today's rate. */
  async setSellingPrice(
    customerId: string,
    productId: string,
    input: SellingPriceInput,
  ): Promise<SellingPriceRow> {
    await this.merchant(customerId, true);
    const product = await this.product(productId);
    if (input.currency === 'syp') {
      const rate = await this.rates.current();
      // A06-41: no rate is its own refusal, not a price above the limit.
      if (!rate) {
        throw refusals.invalid('currency', 'No exchange rate in force to convert a SYP price at');
      }
      if (sellingPriceTooHigh(input, rate.sypPerUsd)) {
        throw refusals.invalid('amountUnits', 'Above $10,000 at the rate in force');
      }
    }
    const values = { currency: input.currency, amountUnits: input.amountUnits };
    await this.db
      .insert(merchantSellingPrices)
      .values({ customerId, productId, ...values })
      .onConflictDoUpdate({
        target: [merchantSellingPrices.customerId, merchantSellingPrices.productId],
        set: values,
      });
    return this.row(customerId, product);
  }

  /** `DELETE /api/merchant/selling-prices/:productId` (SP2): back to the markup. */
  async clearSellingPrice(customerId: string, productId: string): Promise<SellingPriceRow> {
    await this.merchant(customerId, true);
    const product = await this.product(productId);
    await this.db
      .delete(merchantSellingPrices)
      .where(
        and(
          eq(merchantSellingPrices.customerId, customerId),
          eq(merchantSellingPrices.productId, productId),
        ),
      );
    return this.row(customerId, product);
  }

  private async product(productId: string): Promise<{ id: string; gameId: string }> {
    if (!isUuid(productId)) throw refusals.notFound('product');
    const [product] = await liveProducts(this.db, [productId]);
    if (!product) throw refusals.notFound('product');
    return product;
  }

  private async row(
    customerId: string,
    product: { id: string; gameId: string },
  ): Promise<SellingPriceRow> {
    const [row] = (await this.pricesOf(customerId, product.gameId, product.id)).products;
    if (!row) throw refusals.notFound('product');
    return row;
  }

  /** `GET /api/merchant/watches` (AL1). */
  async watches(customerId: string): Promise<Watches> {
    await this.merchant(customerId);
    const followed = await merchantWatchRows(this.db, customerId);
    return { ...followed, suggestions: await watchSuggestions(this.db, customerId, followed) };
  }

  /** `PUT /api/merchant/watches` (AL1): the whole set, at most 200, of unarchived items. */
  async saveWatches(customerId: string, input: UpdateWatches): Promise<Watches> {
    await this.merchant(customerId, true);
    if (input.gameIds.length + input.productIds.length > WATCHES_MAX) {
      throw new CodedException(409, 'WATCHES_LIMIT_REACHED', 'At most 200 follows', {
        limit: WATCHES_MAX,
      });
    }
    const [games, products] = [
      await liveGames(this.db, input.gameIds),
      await liveProducts(this.db, input.productIds),
    ];
    if (games.length !== input.gameIds.length || products.length !== input.productIds.length) {
      throw refusals.notFound('game or product');
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`watches:${customerId}`}))`);
      await tx.delete(merchantWatches).where(eq(merchantWatches.customerId, customerId));
      const rows = [
        ...input.gameIds.map((gameId) => ({ customerId, gameId })),
        ...input.productIds.map((productId) => ({ customerId, productId })),
      ];
      if (rows.length > 0) await tx.insert(merchantWatches).values(rows);
    });
    return this.watches(customerId);
  }

  /** `GET /api/merchant/alerts`: the last 90 days, newest first. */
  async alerts(customerId: string, query: MerchantAlertQuery): Promise<MerchantAlertPage> {
    await this.merchant(customerId);
    const rows = await alertEvents(this.db, customerId, {
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit + 1,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        id: row.id,
        productId: row.productId,
        gameNameAr: row.gameNameAr,
        productNameAr: row.productNameAr,
        kind: row.kind,
        oldPriceUsdUnits: row.oldPriceUsdUnits,
        newPriceUsdUnits: row.newPriceUsdUnits,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    };
  }

  /** `GET /api/merchant/alert-settings` (AL4, AL5). */
  async alertSettings(customerId: string): Promise<AlertSettings> {
    await this.merchant(customerId);
    return this.alertSettingsOf(customerId);
  }

  /** `PUT /api/merchant/alert-settings`: a new threshold re-arms the alert (AL6). */
  async saveAlertSettings(customerId: string, input: AlertSettings): Promise<AlertSettings> {
    await this.merchant(customerId, true);
    const before = await this.alertSettingsOf(customerId);
    const values = {
      lowBalanceUsdUnits: input.lowBalanceUsdUnits,
      dailyEmail: input.dailyEmail,
      ...(before.lowBalanceUsdUnits !== input.lowBalanceUsdUnits && {
        lowBalanceAlertedAt: null,
        lowBalanceAlertedPosition: null,
      }),
    };
    await this.db
      .insert(merchantAlertSettings)
      .values({ customerId, ...values })
      .onConflictDoUpdate({ target: merchantAlertSettings.customerId, set: values });
    return this.alertSettingsOf(customerId);
  }

  private async alertSettingsOf(customerId: string): Promise<AlertSettings> {
    const [row] = await this.db
      .select({
        lowBalanceUsdUnits: merchantAlertSettings.lowBalanceUsdUnits,
        dailyEmail: merchantAlertSettings.dailyEmail,
      })
      .from(merchantAlertSettings)
      .where(eq(merchantAlertSettings.customerId, customerId));
    return row ?? NO_ALERT_SETTINGS;
  }
}
