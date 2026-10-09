import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalFields,
  cleanPlayerName,
  PLAYER_CHECK_TIMEOUT_MS,
  PLAYER_CHECK_TTL_MS,
  type PlayerCheck,
  type PlayerCheckRequest,
  supplierServesCustomer,
} from '@vertex-digital/contracts';
import {
  checkOrderFields,
  type Database,
  damascusDate,
  newId,
  type PlayerCheckLookup,
  type ProductRoutingState,
  playerChecks,
  productRoutingStates,
  queueTelegramMessage,
  type RouteState,
  type Transaction,
  validationsToday,
} from '@vertex-digital/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { AuthService, withinLimits } from '../auth/index.js';
import { SupplierAdaptersService } from '../suppliers/index.js';
import { orderRefusals } from './order-errors.js';

type Executor = Database | Transaction;

const HOUR = 60 * 60 * 1000;

/** A route a player check may use (rule PV2), with its supplier's quota. */
interface CheckRoute {
  route: RouteState;
  quota: number;
}

/** Thrown by a supplier call that took longer than rule PV6 allows. */
class Timeout extends Error {}

/**
 * Player checks (S09 rules PV1–PV8): the supplier's answer for a player id, cached by an HMAC of
 * the fields (`player_checks`, no player id stored), limited per customer and address for the
 * calls that reach a supplier, and bounded by each supplier's daily quota. The purchase reads the
 * same cache (`lookup`) and never calls a supplier.
 */
@Injectable()
export class PlayerChecksService {
  private readonly key: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
    private readonly adapters: SupplierAdaptersService,
    private readonly customers: AuthService,
  ) {
    this.key = Buffer.from(env.PLAYER_CHECK_SECRET as string, 'base64');
  }

  /** `POST /api/player-checks`. */
  async check(
    customerId: string,
    request: PlayerCheckRequest,
    meta: RequestMeta,
  ): Promise<PlayerCheck> {
    const state = (
      await productRoutingStates(this.db, [request.productId], routingContext(this.env))
    ).get(request.productId);
    if (!state || state.availability === 'hidden' || state.availability === 'paused') {
      throw orderRefusals.notFound();
    }
    if (state.availability !== 'available') {
      throw new CodedException(409, 'PRODUCT_UNAVAILABLE', 'The product cannot be bought now', {
        availability: state.availability,
      });
    }
    const fields = await this.parsedFields(state.gameId, request.fields ?? {});
    if (state.kind !== 'direct') return { result: 'not_supported' };
    const isTest = await this.customers.isTestCustomer(customerId);
    const routes = this.checkRoutes(state, isTest);
    if (routes.length === 0) return { result: 'not_supported' };

    const fieldsHash = this.fieldsHash(state.gameId, fields);
    const cached = await this.cached(this.db, state.gameId, fieldsHash);
    if (cached) return cached;

    const used = await validationsToday(
      this.db,
      routes.map(({ route }) => route.supplier.id),
    );
    for (const { route, quota } of routes) {
      if ((used.get(route.supplier.id) ?? 0) >= quota) {
        await this.quotaReached(route, quota);
        continue;
      }
      return this.ask(route, state.gameId, fieldsHash, fields, customerId, meta);
    }
    return { result: 'unavailable', reason: 'quota' };
  }

  /**
   * Rule PV8 for the purchase, in its transaction: null when no check is possible for this
   * customer now (rule PV1), else what the cache holds for these fields.
   */
  async lookup(
    tx: Transaction,
    order: {
      productId: string;
      gameId: string;
      productKind: 'direct' | 'code';
      isTest: boolean;
      fields: Record<string, string>;
    },
  ): Promise<PlayerCheckLookup | null> {
    if (order.productKind !== 'direct') return null;
    const state = (await productRoutingStates(tx, [order.productId], routingContext(this.env))).get(
      order.productId,
    );
    if (!state) return null;
    const routes = this.checkRoutes(state, order.isTest);
    const used = await validationsToday(
      tx,
      routes.map(({ route }) => route.supplier.id),
    );
    if (!routes.some(({ route, quota }) => (used.get(route.supplier.id) ?? 0) < quota)) {
      return null;
    }
    const cached = await this.cached(tx, order.gameId, this.fieldsHash(order.gameId, order.fields));
    if (!cached) return { result: 'none' };
    return cached.result === 'valid'
      ? { result: 'valid', playerName: cached.playerName }
      : { result: 'invalid' };
  }

  /**
   * Rules PV1, PV2: the usable routes in order (RT5–RT6) whose supplier checks player ids here
   * with a quota above 0; a test customer's only through `fake` (S08 R4).
   */
  private checkRoutes(state: ProductRoutingState, isTest: boolean): CheckRoute[] {
    return state.routes
      .filter(
        (route) =>
          route.unusableReason === null &&
          route.archivedAt === null &&
          (isTest
            ? route.supplierCode === 'fake'
            : supplierServesCustomer(route.supplierCode, false)) &&
          this.adapters.canValidatePlayer(route.supplierCode) &&
          route.supplier.validationDailyQuota > 0,
      )
      .map((route) => ({ route, quota: route.supplier.validationDailyQuota }));
  }

  /** Rule BB2: the game's unarchived fields, the same schema the purchase uses. */
  private async parsedFields(
    gameId: string,
    values: Record<string, string>,
  ): Promise<Record<string, string>> {
    const checked = await this.db.transaction((tx) => checkOrderFields(tx, gameId, values));
    if (!checked.ok) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'The account fields are not valid', {
        fields: checked.refusals,
      });
    }
    return checked.fields;
  }

  /** HMAC-SHA-256 of the game id and the fields' canonical values (`canonicalFields`). */
  private fieldsHash(gameId: string, fields: Record<string, string>): string {
    const canonical = JSON.stringify([gameId, canonicalFields(fields)]);
    return createHmac('sha256', this.key).update(canonical).digest('hex');
  }

  /** Rule PV3: the newest unexpired answer for these fields, whoever asked. */
  private async cached(
    db: Executor,
    gameId: string,
    fieldsHash: string,
  ): Promise<Extract<PlayerCheck, { result: 'valid' | 'invalid' }> | null> {
    const [row] = await db
      .select({ result: playerChecks.result, playerName: playerChecks.playerName })
      .from(playerChecks)
      .where(
        and(
          eq(playerChecks.gameId, gameId),
          eq(playerChecks.fieldsHash, fieldsHash),
          gt(playerChecks.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(playerChecks.createdAt))
      .limit(1);
    if (!row) return null;
    return row.result === 'valid'
      ? { result: 'valid', playerName: row.playerName }
      : { result: 'invalid' };
  }

  /**
   * One supplier call (rule PV6): mapped by the route's `field_map`, 5 seconds at most, recorded
   * in `supplier_calls`; an answer is cached, an error or timeout is `unavailable`.
   */
  private async ask(
    route: RouteState,
    gameId: string,
    fieldsHash: string,
    fields: Record<string, string>,
    customerId: string,
    meta: RequestMeta,
  ): Promise<PlayerCheck> {
    const adapter = await this.adapters.connect(route.supplier);
    if (!adapter?.capabilities.validatePlayer) return { result: 'not_supported' };
    // Rule PV4: only a request that is about to call a supplier counts.
    const allowed = await withinLimits(this.db, [
      { key: `player-check:customer:${customerId}`, max: 10, windowMs: HOUR },
      { key: `player-check:customer-day:${customerId}`, max: 30, windowMs: 24 * HOUR },
      { key: `player-check:ip:${meta.ipAddress ?? 'unknown'}`, max: 30, windowMs: HOUR },
    ]);
    if (!allowed) throw orderRefusals.rateLimited();
    const mapped = Object.fromEntries(
      Object.entries(route.fieldMap).map(([supplierField, key]) => [
        supplierField,
        fields[key] ?? '',
      ]),
    );
    const started = performance.now();
    let answer: { valid: boolean; playerName?: string } | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      answer = await Promise.race([
        adapter.validatePlayer({ offerId: route.offer.offerId, fields: mapped }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Timeout()), PLAYER_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch {
      answer = null;
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    return this.db.transaction(async (tx) => {
      await this.adapters.recordCall(tx, {
        supplierId: route.supplier.id,
        operation: 'validate_player',
        result: answer === null ? 'error' : 'ok',
        latencyMs,
      });
      if (answer === null) return { result: 'unavailable', reason: 'supplier' } as const;
      const result = answer.valid ? 'valid' : 'invalid';
      const playerName = answer.valid ? cleanPlayerName(answer.playerName) : null;
      await tx.insert(playerChecks).values({
        id: newId(),
        gameId,
        fieldsHash,
        result,
        playerName,
        supplierId: route.supplier.id,
        customerId,
        expiresAt: new Date(Date.now() + PLAYER_CHECK_TTL_MS[result]),
      });
      return result === 'valid' ? { result, playerName } : { result };
    });
  }

  /** Rule PV5: the first refusal of the day tells the admin, once (its dedupe key). */
  private async quotaReached(route: RouteState, quota: number): Promise<void> {
    await this.db.transaction((tx) =>
      queueTelegramMessage(tx, this.jobs, {
        kind: 'validation_quota_reached',
        params: { supplier: route.supplierCode, supplierNameAr: route.supplier.nameAr, quota },
        dedupeKey: `validation-quota:${route.supplierCode}:${damascusDate(new Date())}`,
      }),
    );
  }
}
