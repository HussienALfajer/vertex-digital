import { Inject, Injectable } from '@nestjs/common';
import {
  damascusMonth,
  type MerchantPriceList,
  type MerchantPriceListGame,
  type MerchantPriceListQuery,
  monthSchema,
  PRICE_LIST_IMAGES_PER_HOUR,
  priceListLine,
  priceListPage,
  priceListPages,
  STATEMENT_EXPORTS_PER_HOUR,
  type Statement,
  type StatementMonths,
  type StatementTier,
  statementBalances,
  statementMonths,
  statementTotals,
  tierProgress,
} from '@vertex-digital/contracts';
import {
  type Database,
  liveTierLevels,
  merchantPrivileges,
  merchantWatchRows,
  monthsPurchases,
  receiptSettingsOf,
  shownGames,
  statementAccount,
  statementFacts,
  tierMonthOf,
  tierSavings,
  withinLimits,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { FilesService } from '../files/index.js';
import { refusals, requireMerchant } from './merchant-access.js';
import { MerchantToolsService } from './merchant-tools.service.js';
import { renderPriceListImage } from './price-list-image.js';
import { statementFileName, statementWorkbook } from './statement-workbook.js';

const HOUR = 60 * 60 * 1000;

/** A06-40: statement pages a merchant may read in an hour (each sums a month of the ledger). */
const STATEMENT_READS_PER_HOUR = 60;

const rateLimited = () => new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later');

const monthInvalid = () =>
  new CodedException(422, 'STATEMENT_MONTH_INVALID', 'Not a month of this account');

/**
 * The merchant's documents (S21 F36, F38): the price list (PL1–PL3) as rows for the print page
 * and as a PNG, and the monthly statement (ST1–ST3) as a page and an `.xlsx`. Merchants only,
 * frozen ones too (reads); nothing here writes but the rate-limit counters.
 */
@Injectable()
export class MerchantDocumentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tools: MerchantToolsService,
    private readonly files: FilesService,
  ) {}

  /** `GET /api/merchant/price-list` (PL1, PL2). */
  async priceList(customerId: string, query: MerchantPriceListQuery): Promise<MerchantPriceList> {
    await requireMerchant(this.db, customerId);
    const branding = await receiptSettingsOf(this.db, customerId);
    const privileges = await merchantPrivileges(this.db, customerId);
    if (!branding || !privileges) throw refusals.notMerchant();
    const games = await shownGames(this.db, privileges.settings.earlyAccess);
    const gameIds = await this.listGames(
      customerId,
      games.map((game) => game.id),
      query.gameIds,
    );
    const { rate, storeStepUnits, rows } = await this.tools.sellingRows(customerId, gameIds);
    let omittedCount = 0;
    const listed: MerchantPriceListGame[] = [];
    for (const game of games.filter((candidate) => gameIds.includes(candidate.id))) {
      const lines: MerchantPriceListGame['rows'] = [];
      for (const row of rows.filter((candidate) => candidate.gameId === game.id)) {
        const line = priceListLine(row, query, rate, storeStepUnits);
        if (line.kind === 'omitted') omittedCount += 1;
        if (line.kind === 'price' || line.kind === 'unavailable') {
          lines.push({
            productId: row.productId,
            nameAr: row.nameAr,
            available: line.kind === 'price',
            usdUnits: line.kind === 'price' ? line.usdUnits : null,
            sypUnits: line.kind === 'price' ? line.sypUnits : null,
          });
        }
      }
      if (lines.length > 0) listed.push({ gameId: game.id, nameAr: game.nameAr, rows: lines });
    }
    return {
      tradeName: branding.tradeName,
      logoFileId: branding.logoFileId,
      tier: privileges.tier,
      largeLogo: privileges.settings.receiptLargeLogo,
      generatedAt: new Date().toISOString(),
      mode: query.mode,
      currency: query.currency,
      gameIds,
      games: listed,
      omittedCount,
      imagePages: priceListPages(listed),
    };
  }

  /** PL1: the games asked for among the store's, else the followed ones, else all of them. */
  private async listGames(
    customerId: string,
    shown: string[],
    asked: string[] | undefined,
  ): Promise<string[]> {
    if (asked) return shown.filter((id) => asked.includes(id));
    const followed = await merchantWatchRows(this.db, customerId);
    const ids = new Set([
      ...followed.games.map((game) => game.gameId),
      ...followed.products.map((product) => product.gameId),
    ]);
    const games = shown.filter((id) => ids.has(id));
    return games.length > 0 ? games : shown;
  }

  /** `GET /api/merchant/price-list.png` (PL3): one page of 60 packs, 20 an hour. */
  async priceListImage(customerId: string, query: MerchantPriceListQuery): Promise<Buffer> {
    await requireMerchant(this.db, customerId);
    const allowed = await withinLimits(this.db, [
      {
        key: `price-list-image:customer:${customerId}`,
        max: PRICE_LIST_IMAGES_PER_HOUR,
        windowMs: HOUR,
      },
    ]);
    if (!allowed) throw rateLimited();
    const list = await this.priceList(customerId, query);
    if (query.page > list.imagePages) throw refusals.notFound('page');
    const logo = list.logoFileId ? await this.files.serve(list.logoFileId, 'merchant_logo') : null;
    return renderPriceListImage(
      { ...list, games: priceListPage(list.games, query.page) },
      { page: query.page, pages: list.imagePages },
      logo ? await logo.read() : null,
    );
  }

  /** `GET /api/merchant/statements` (ST1). */
  async statements(customerId: string): Promise<StatementMonths> {
    await requireMerchant(this.db, customerId);
    const account = await statementAccount(this.db, customerId);
    if (!account) throw refusals.notMerchant();
    const now = new Date();
    const current = damascusMonth(now);
    return {
      items: statementMonths(account.createdAt, now).map((month) => ({
        month,
        current: month === current,
      })),
    };
  }

  /** `GET /api/merchant/statements/:month` (ST2): 60 an hour (A06-40). */
  async statementPage(customerId: string, month: string): Promise<Statement> {
    await requireMerchant(this.db, customerId);
    const allowed = await withinLimits(this.db, [
      {
        key: `statement-read:customer:${customerId}`,
        max: STATEMENT_READS_PER_HOUR,
        windowMs: HOUR,
      },
    ]);
    if (!allowed) throw rateLimited();
    return this.statement(customerId, month);
  }

  /** A month's statement, the balance equation checked (A13). */
  private async statement(customerId: string, month: string): Promise<Statement> {
    await requireMerchant(this.db, customerId);
    const account = await statementAccount(this.db, customerId);
    if (!account) throw refusals.notMerchant();
    const now = new Date();
    if (
      !monthSchema.safeParse(month).success ||
      !statementMonths(account.createdAt, now).includes(month)
    ) {
      throw monthInvalid();
    }
    const facts = await statementFacts(this.db, customerId, month);
    if (!statementBalances(facts.openingUsdUnits, facts.entries, facts.closingUsdUnits)) {
      // A13: an unhandled error, reported to Sentry and the admin's alerts; never shown as is.
      throw new Error(`Statement ${month} of customer ${customerId} does not balance`);
    }
    return {
      month,
      current: month === damascusMonth(now),
      generatedAt: now.toISOString(),
      tradeName: account.tradeName,
      email: account.email,
      openingUsdUnits: facts.openingUsdUnits,
      closingUsdUnits: facts.closingUsdUnits,
      entries: facts.entries,
      totals: statementTotals(facts.entries),
      tier: await this.statementTier(customerId, month, now),
    };
  }

  /**
   * S23 ID9: the tier held at the month's end (now for this month), its net purchases, the savings
   * (PG6; none at Bronze) and the next tier with what was missing; null before the history starts.
   */
  private async statementTier(
    customerId: string,
    month: string,
    now: Date,
  ): Promise<StatementTier | null> {
    let held: StatementTier['tier'];
    let net: number;
    if (month === damascusMonth(now)) {
      const privileges = await merchantPrivileges(this.db, customerId);
      if (!privileges) return null;
      held = privileges.tier;
      net = (await monthsPurchases(this.db, customerId, now)).thisMonthUsdUnits;
    } else {
      const row = await tierMonthOf(this.db, customerId, month);
      if (!row) return null;
      held = row.heldTier;
      net = row.netPurchasesUsdUnits;
    }
    const next = tierProgress(await liveTierLevels(this.db), net, held).next;
    return {
      tier: held,
      netPurchasesUsdUnits: net,
      savingsUsdUnits: held === 'bronze' ? null : await tierSavings(this.db, customerId, month),
      next: next && { tier: next.tier, missingUsdUnits: next.missingUsdUnits },
    };
  }

  /** `GET /api/merchant/statements/:month/export` (ST3): 20 an hour. */
  async statementExport(
    customerId: string,
    month: string,
  ): Promise<{ fileName: string; body: Buffer }> {
    await requireMerchant(this.db, customerId);
    const allowed = await withinLimits(this.db, [
      {
        key: `statement-export:customer:${customerId}`,
        max: STATEMENT_EXPORTS_PER_HOUR,
        windowMs: HOUR,
      },
    ]);
    if (!allowed) throw rateLimited();
    const statement = await this.statement(customerId, month);
    return { fileName: statementFileName(month), body: await statementWorkbook(statement) };
  }
}
