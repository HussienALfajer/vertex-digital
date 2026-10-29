import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminOrder,
  type AdminPurchaseContext,
  type AdminPurchaseGames,
  type createAdminOrderSchema,
  ownerCapRemaining,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import {
  accountBalance,
  accountMerchant,
  accountPriceList,
  adminOrder,
  adminPurchaseOrder,
  adminSaleRanks,
  currentOrderPolicy,
  customerLimitOverrides,
  customerSavedPlayers,
  type Database,
  findCustomerWallet,
  gameListPrices,
  orders,
  ownerSpentToday,
  purchasedLastDay,
  type Transaction,
  withinLimits,
} from '@vertex-digital/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { JobsService } from '../../core/jobs/index.js';
import { AuthService } from '../auth/index.js';
import { CatalogService } from '../catalog/index.js';
import { SettingsService } from '../settings/index.js';
import type { DecisionActor } from './order-decisions.service.js';
import { asCodedException, orderRefusals } from './order-errors.js';
import { PlayerChecksService } from './player-checks.service.js';

const TEN_MINUTES = 10 * 60 * 1000;

/** An admin purchase as the controller parsed it. */
export type AdminPurchaseBody = z.output<typeof createAdminOrderSchema>;

const sortedFields = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));

/** The body a key replays (rule AP2): the same fields in any order are the same request. */
export function adminRequestHash(body: AdminPurchaseBody) {
  const canonical = JSON.stringify([
    'admin',
    body.purpose,
    body.customerId ?? null,
    body.productId,
    body.quantity,
    sortedFields(body.fields),
    body.expectedUnitPriceUsdUnits,
    body.confirmPlayer,
    body.reason,
    body.customerNote ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Purchases from the panel (S16 rules AP1–AP13): the order through `adminPurchaseOrder` in
 * `packages/db` under the switches' shared lock, 30 per 10 minutes for the admin, the player check
 * read from S09's cache; and the dialog's context (the customer's wallet, cap and saved ids, the
 * owner cap used today).
 */
@Injectable()
export class AdminPurchasesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly playerChecks: PlayerChecksService,
    private readonly customers: AuthService,
    private readonly catalog: CatalogService,
  ) {}

  /** Rules AP2–AP13: `created` is false when the key replayed an earlier order of this body. */
  async create(
    actor: DecisionActor,
    idempotencyKey: string,
    body: AdminPurchaseBody,
  ): Promise<{ order: AdminOrder; created: boolean }> {
    // A key that already holds an admin order is a replay: it spends no limit (audit A04-19).
    const [held] = z.uuid().safeParse(idempotencyKey).success
      ? await this.db
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.idempotencyKey, idempotencyKey), isNotNull(orders.adminId)))
          .limit(1)
      : [];
    const allowed =
      held !== undefined ||
      (await withinLimits(this.db, [
        { key: `admin-order:${actor.adminId}`, max: 30, windowMs: TEN_MINUTES },
      ]));
    if (!allowed) throw orderRefusals.rateLimited();
    try {
      const { order, created } = await this.db.transaction(async (tx) => {
        const switches = await this.settings.valuesForCreation(tx);
        return adminPurchaseOrder(
          tx,
          { jobs: this.jobs, now: new Date() },
          {
            adminId: actor.adminId,
            purpose: body.purpose,
            customerId: body.customerId ?? null,
            productId: body.productId,
            quantity: body.quantity,
            fields: body.fields,
            expectedUnitPriceUsdUnits: body.expectedUnitPriceUsdUnits,
            confirmPlayer: body.confirmPlayer,
            reason: body.reason,
            customerNote: body.customerNote ?? null,
            idempotencyKey,
            requestHash: adminRequestHash(body),
            fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
            purchasesStopped: switches.purchases_stopped,
            playerCheck: (tx: Transaction, order) => this.playerChecks.lookup(tx, order),
            ipAddress: actor.meta.ipAddress,
            userAgent: actor.meta.userAgent,
          },
        );
      });
      return { order: (await adminOrder(this.db, order.id)) as AdminOrder, created };
    } catch (error) {
      throw asCodedException(error);
    }
  }

  /**
   * `GET /api/admin/orders/purchase-context` (rules AP4, AP7, AP8); S20 PO4, MT2: the customer's
   * price kind, terms state and, with a game, its packs at the customer's list.
   */
  async context(
    customerId: string | undefined,
    gameId?: string | undefined,
  ): Promise<AdminPurchaseContext> {
    const [policy, spent] = await Promise.all([
      currentOrderPolicy(this.db),
      ownerSpentToday(this.db),
    ]);
    const owner = {
      capUsdUnits: policy.ownerDailyCapUsdUnits,
      usedTodayUsdUnits: spent.usedUsdUnits,
      remainingUsdUnits: ownerCapRemaining(policy.ownerDailyCapUsdUnits, spent.usedUsdUnits),
    };
    if (customerId === undefined) return { customer: null, owner };
    const row = await this.customers.purchaseCustomer(customerId);
    if (!row || row.archived) throw orderRefusals.notFound();
    const [wallet, overrides, used, saved, pricing, merchant] = await Promise.all([
      findCustomerWallet(this.db, customerId),
      customerLimitOverrides(this.db, customerId),
      purchasedLastDay(this.db, customerId),
      customerSavedPlayers(this.db, customerId),
      accountPriceList(this.db, customerId),
      accountMerchant(this.db, customerId),
    ]);
    const cap = overrides.dailyPurchaseUsdUnits;
    const listId = pricing?.effectiveList.id ?? ROOT_PRICE_LIST_IDS.retail;
    const listPrices =
      gameId === undefined || listId === ROOT_PRICE_LIST_IDS.retail
        ? null
        : await gameListPrices(this.db, gameId, listId, routingContext(this.env));
    return {
      customer: {
        id: row.id,
        name: row.name,
        email: row.email,
        isTest: row.isTest,
        emailVerified: row.emailVerified,
        frozen: row.frozen,
        balanceUsdUnits: wallet ? await accountBalance(this.db, wallet) : 0,
        purchaseCapLeftUsdUnits: cap === null ? null : Math.max(0, cap - used),
        priceKind: pricing?.priceKind ?? 'retail',
        merchantTermsRequired: merchant !== null && !merchant.termsAccepted,
        listPrices,
        savedPlayers: saved.map((player) => ({
          id: player.id,
          gameId: player.gameId,
          label: player.label,
          fields: player.fields,
          playerName: player.playerName,
        })),
      },
      owner,
    };
  }

  /**
   * `GET /api/admin/orders/purchase-games`: the sale picker's games with their 30-day sales and
   * the game of the newest admin order (S16 "شراء من اللوحة").
   */
  async games(): Promise<AdminPurchaseGames> {
    const [catalog, ranks] = await Promise.all([this.catalog.saleGames(), adminSaleRanks(this.db)]);
    return {
      categories: catalog.categories,
      games: catalog.games.map((game) => ({
        ...game,
        soldLast30Days: ranks.sold.get(game.id) ?? 0,
      })),
      lastGameId: ranks.lastGameId,
    };
  }
}
