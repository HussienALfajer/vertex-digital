import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  canonicalFields,
  cleanPlayerName,
  PLAYER_CHECK_TIMEOUT_MS,
  PLAYER_CHECK_TTL_MS,
  type PlayerCheck,
  type PlayerCheckRequest,
  playerRegionSchema,
  regionMismatch,
  type SupplierCode,
  supplierServesCustomer,
} from '@vertex-digital/contracts';
import {
  applicant,
  checkOrderFields,
  currentMerchantSettings,
  type Database,
  damascusDate,
  lockActiveCustomer,
  newId,
  type PlayerCheckLookup,
  type ProductRoutingState,
  playerCheckProviders,
  playerChecks,
  productRoutingStates,
  queueTelegramMessage,
  supplierStates,
  type Transaction,
  validationsToday,
  withinLimits,
} from '@vertex-digital/db';
import { type PlayerValidation, SupplierError } from '@vertex-digital/suppliers';
import { and, desc, eq, gt } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { AuthService } from '../auth/index.js';
import { SupplierAdaptersService } from '../suppliers/index.js';
import { asCodedException, orderRefusals } from './order-errors.js';

type Executor = Database | Transaction;

const HOUR = 60 * 60 * 1000;

/**
 * Where one check may go (S19 PC1, S09 PV2): the game's provider by its check category, or a
 * route by its offer; what it sends, and the supplier's daily quota.
 */
interface CheckTarget {
  supplier: { id: string; code: SupplierCode; nameAr: string };
  quota: number;
  fieldMap: Record<string, string>;
  optionMap: Record<string, Record<string, string>>;
  offerId?: string;
  categoryId?: string;
}

/**
 * Who checks a pack for a requester: nobody (`not_supported`, and the purchase needs no
 * confirmation), a provider that cannot answer now (S19 PC5: `unavailable`, the customer
 * confirms), or targets in order with the game's allowed regions (PC3; none for a route).
 */
type CheckPlan = { allowedRegions: readonly string[] } & (
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'targets'; targets: CheckTarget[] }
);

/** A cached or fresh answer before the game's regions are applied. */
type Answer =
  | { result: 'valid'; playerName: string | null; region: string | null }
  | { result: 'invalid' };

/** Thrown by a supplier call that took longer than rule PV6 allows. */
class Timeout extends Error {}

/** Who asks: a customer in the store, or the admin buying from the panel (S16 rule AP8). */
type Requester = { kind: 'customer'; id: string } | { kind: 'admin'; id: string };

/**
 * Player checks (S09 rules PV1–PV8): the supplier's answer for a player id, cached by an HMAC of
 * the fields (`player_checks`, no player id stored), limited per customer and address for the
 * calls that reach a supplier, and bounded by each supplier's daily quota. The purchase reads the
 * same cache (`lookup`) and never calls a supplier. S19 PC1–PC9: a game with an enabled check
 * provider is checked by it for every `direct` pack; an answer keeps the account's region, which
 * the game's allowed regions turn into `region_mismatch` whenever it is read.
 */
@Injectable()
export class PlayerChecksService {
  private readonly logger = new Logger(PlayerChecksService.name);
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
  check(customerId: string, request: PlayerCheckRequest, meta: RequestMeta): Promise<PlayerCheck> {
    return this.run({ kind: 'customer', id: customerId }, request, meta);
  }

  /**
   * S21 BK2, BK4: one line of a merchant's bulk list, checked as the store's check does; a quota
   * used up (the merchant's, or the address's) answers `unavailable` (`quota`), "لم يُفحص", so the
   * line can still be paid with the merchant's confirmation.
   */
  async checkLine(
    customerId: string,
    request: PlayerCheckRequest,
    meta: RequestMeta,
  ): Promise<PlayerCheck> {
    try {
      return await this.check(customerId, request, meta);
    } catch (error) {
      if (
        error instanceof CodedException &&
        (error.code === 'PLAYER_CHECK_QUOTA_EXCEEDED' || error.code === 'RATE_LIMITED')
      ) {
        return { result: 'unavailable', reason: 'quota' };
      }
      throw error;
    }
  }

  /**
   * `POST /api/admin/player-checks` (S16 rule AP8): the same check and cache with the admin as
   * requester, the supplier's daily quota counted, 30 supplier calls per 10 minutes; a pack the
   * admin paused may be checked (an owner-funded order may buy it, AP5).
   */
  checkForAdmin(adminId: string, request: PlayerCheckRequest): Promise<PlayerCheck> {
    return this.run({ kind: 'admin', id: adminId }, request, null);
  }

  private async run(
    requester: Requester,
    request: PlayerCheckRequest,
    meta: RequestMeta | null,
  ): Promise<PlayerCheck> {
    // S12 CF2: a frozen customer spends no supplier quota.
    if (requester.kind === 'customer') {
      await this.db
        .transaction((tx) => lockActiveCustomer(tx, requester.id))
        .catch((error: unknown) => {
          throw asCodedException(error);
        });
    }
    const state = (
      await productRoutingStates(this.db, [request.productId], routingContext(this.env))
    ).get(request.productId);
    const paused = state?.availability === 'paused' && requester.kind === 'customer';
    if (!state || state.availability === 'hidden' || paused) {
      throw orderRefusals.notFound();
    }
    if (state.availability !== 'available' && state.availability !== 'paused') {
      throw new CodedException(409, 'PRODUCT_UNAVAILABLE', 'The product cannot be bought now', {
        availability: state.availability,
      });
    }
    const fields = await this.parsedFields(state.gameId, request.fields ?? {});
    if (state.kind !== 'direct') return { result: 'not_supported' };
    const isTest =
      requester.kind === 'customer' && (await this.customers.isTestCustomer(requester.id));
    const plan = await this.plan(this.db, state, isTest);
    if (plan.kind === 'none') return { result: 'not_supported' };
    if (plan.kind === 'unavailable') return { result: 'unavailable', reason: 'supplier' };

    const fieldsHash = this.fieldsHash(state.gameId, fields);
    const cached = await this.cached(this.db, state.gameId, fieldsHash);
    if (cached) return withRegions(cached, plan.allowedRegions);

    const used = await validationsToday(
      this.db,
      plan.targets.map((target) => target.supplier.id),
    );
    for (const target of plan.targets) {
      if ((used.get(target.supplier.id) ?? 0) >= target.quota) {
        await this.quotaReached(target);
        continue;
      }
      const answer = await this.ask(target, state.gameId, fieldsHash, fields, requester, meta);
      return answer.result === 'valid' || answer.result === 'invalid'
        ? withRegions(answer, plan.allowedRegions)
        : answer;
    }
    return { result: 'unavailable', reason: 'quota' };
  }

  /**
   * Rule PV8 for the purchase, in its transaction: null when no check is possible for this
   * customer now (rule PV1), else what the cache holds for these fields. S19 PC3: a cached account
   * on a region the game does not allow is `region_mismatch` whatever the provider can do now
   * (paused, out of quota), so a confirmation never buys a pack for another region.
   */
  async lookup(
    tx: Transaction,
    order: {
      productId: string;
      gameId: string;
      productKind: 'direct' | 'code';
      isTest: boolean;
      fields: Record<string, string>;
      routing?: ProductRoutingState;
    },
  ): Promise<PlayerCheckLookup | null> {
    if (order.productKind !== 'direct') return null;
    const state =
      order.routing ??
      (await productRoutingStates(tx, [order.productId], routingContext(this.env))).get(
        order.productId,
      );
    if (!state) return null;
    const plan = await this.plan(tx, state, order.isTest);
    const cached = await this.cached(tx, order.gameId, this.fieldsHash(order.gameId, order.fields));
    const answer = cached && withRegions(cached, plan.allowedRegions);
    if (answer?.result === 'region_mismatch') {
      return { result: 'region_mismatch', region: answer.region };
    }
    if (plan.kind === 'none') return null;
    if (plan.kind === 'targets') {
      const used = await validationsToday(
        tx,
        plan.targets.map((target) => target.supplier.id),
      );
      if (!plan.targets.some((target) => (used.get(target.supplier.id) ?? 0) < target.quota)) {
        return null;
      }
    }
    return answer ?? { result: 'none' };
  }

  /**
   * S19 PC1, PC5, PC8: a game with an enabled provider row is checked by that provider only: not
   * at all for a test customer unless it is the fake, `unavailable` while it is paused, without
   * credentials, on an inactive plan (FC9) or down. Without one, rules PV1, PV2: the usable routes
   * in order (RT5–RT6) whose supplier checks player ids by a route with a quota above 0; a test
   * customer's only through `fake` (S08 R4).
   */
  private async plan(
    db: Executor,
    state: ProductRoutingState,
    isTest: boolean,
  ): Promise<CheckPlan> {
    const provider = (await playerCheckProviders(db, [state.gameId])).get(state.gameId);
    if (provider?.enabled) {
      const { allowedRegions } = provider;
      if (
        (isTest && provider.supplierCode !== 'fake') ||
        !this.adapters.canValidatePlayer(provider.supplierCode) ||
        provider.validationDailyQuota <= 0
      ) {
        return { kind: 'none', allowedRegions };
      }
      const supplier = (await supplierStates(db, routingContext(this.env))).find(
        (row) => row.id === provider.supplierId,
      );
      if (
        !supplier?.configured ||
        supplier.paused ||
        supplier.subscriptionInactive ||
        supplier.health === 'down'
      ) {
        return { kind: 'unavailable', allowedRegions };
      }
      return {
        kind: 'targets',
        targets: [
          {
            supplier,
            quota: provider.validationDailyQuota,
            fieldMap: provider.fieldMap,
            optionMap: provider.optionMap,
            categoryId: provider.categoryId,
          },
        ],
        allowedRegions,
      };
    }
    const targets = state.routes
      .filter(
        (route) =>
          route.unusableReason === null &&
          route.archivedAt === null &&
          (isTest
            ? route.supplierCode === 'fake'
            : supplierServesCustomer(route.supplierCode, false)) &&
          this.adapters.canValidatePlayer(route.supplierCode, 'route') &&
          route.supplier.validationDailyQuota > 0,
      )
      .map(
        (route): CheckTarget => ({
          supplier: route.supplier,
          quota: route.supplier.validationDailyQuota,
          fieldMap: route.fieldMap,
          optionMap: route.optionMap,
          offerId: route.offer.offerId,
        }),
      );
    return targets.length === 0
      ? { kind: 'none', allowedRegions: [] }
      : { kind: 'targets', targets, allowedRegions: [] };
  }

  /** S21 BK4: a merchant's player checks an hour and a day; null for a customer. */
  private async merchantQuota(
    customerId: string,
  ): Promise<{ perHour: number; perDay: number } | null> {
    const person = await applicant(this.db, customerId);
    if (person?.accountType !== 'merchant') return null;
    const settings = await currentMerchantSettings(this.db);
    return { perHour: settings.playerChecksPerHour, perDay: settings.playerChecksPerDay };
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
  private async cached(db: Executor, gameId: string, fieldsHash: string): Promise<Answer | null> {
    const [row] = await db
      .select({
        result: playerChecks.result,
        playerName: playerChecks.playerName,
        region: playerChecks.region,
      })
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
      ? { result: 'valid', playerName: row.playerName, region: row.region }
      : { result: 'invalid' };
  }

  /**
   * One supplier call (rule PV6): mapped by the target's `field_map`, 5 seconds at most, recorded
   * in `supplier_calls`; an answer is cached with its region (S19 PC3), an error or timeout is
   * `unavailable`.
   */
  private async ask(
    target: CheckTarget,
    gameId: string,
    fieldsHash: string,
    fields: Record<string, string>,
    requester: Requester,
    meta: RequestMeta | null,
  ): Promise<Answer | Extract<PlayerCheck, { result: 'unavailable' | 'not_supported' }>> {
    const adapter = await this.adapters.connect(target.supplier);
    if (!adapter?.capabilities.validatePlayer) return { result: 'not_supported' };
    // As the order would send them (S16 MF2: a select as the supplier's option value); an option
    // the target cannot send is never sent to check.
    let sendable = true;
    const mapped = Object.fromEntries(
      Object.entries(target.fieldMap).map(([supplierField, key]) => {
        const value = fields[key] ?? '';
        const options = target.optionMap[supplierField];
        if (!options || value === '') return [supplierField, value];
        const sent = Object.hasOwn(options, value) ? options[value] : undefined;
        if (sent === undefined) sendable = false;
        return [supplierField, sent ?? value];
      }),
    );
    if (!sendable) return { result: 'not_supported' };
    // Rule PV4: only a request that is about to call a supplier counts (S16 AP8: the admin's own).
    // S21 BK4: a merchant's hour and day come from the merchant settings, and so does the
    // address's hour.
    const quota = requester.kind === 'customer' ? await this.merchantQuota(requester.id) : null;
    const allowed = await withinLimits(
      this.db,
      requester.kind === 'admin'
        ? [{ key: `player-check:admin:${requester.id}`, max: 30, windowMs: 10 * 60 * 1000 }]
        : [
            {
              key: `player-check:customer:${requester.id}`,
              max: quota?.perHour ?? 10,
              windowMs: HOUR,
            },
            {
              key: `player-check:customer-day:${requester.id}`,
              max: quota?.perDay ?? 30,
              windowMs: 24 * HOUR,
            },
            {
              key: `player-check:ip:${meta?.ipAddress ?? 'unknown'}`,
              max: quota?.perHour ?? 30,
              windowMs: HOUR,
            },
          ],
    );
    if (!allowed && quota) {
      throw new CodedException(
        429,
        'PLAYER_CHECK_QUOTA_EXCEEDED',
        "The merchant's player checks are used for now",
        { retryAt: new Date(Date.now() + HOUR).toISOString() },
      );
    }
    if (!allowed) throw orderRefusals.rateLimited();
    const started = performance.now();
    let answer: PlayerValidation | null = null;
    let failure: unknown = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      answer = await Promise.race([
        adapter.validatePlayer({
          ...(target.offerId !== undefined && { offerId: target.offerId }),
          ...(target.categoryId !== undefined && { categoryId: target.categoryId }),
          fields: mapped,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Timeout()), PLAYER_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      // Kept for the call's row and the log, so a timeout, a refused key and a 5xx differ
      // (audit A04-7); never the fields.
      failure =
        error instanceof Timeout
          ? new SupplierError('retryable', 'Player check timed out', { failure: 'timeout' })
          : error;
      this.logger.warn(
        `Player check through ${target.supplier.code} failed: ${
          failure instanceof SupplierError ? (failure.details.failure ?? 'other') : 'other'
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    return this.db.transaction(async (tx) => {
      await this.adapters.recordCall(tx, {
        supplierId: target.supplier.id,
        operation: 'validate_player',
        result: answer === null ? 'error' : 'ok',
        latencyMs,
        error: failure,
      });
      if (answer === null) return { result: 'unavailable', reason: 'supplier' } as const;
      const result = answer.valid ? 'valid' : 'invalid';
      const playerName = answer.valid ? cleanPlayerName(answer.playerName) : null;
      const parsedRegion = playerRegionSchema.safeParse(answer.region);
      const region = answer.valid && parsedRegion.success ? parsedRegion.data : null;
      await tx.insert(playerChecks).values({
        id: newId(),
        gameId,
        fieldsHash,
        result,
        playerName,
        region,
        supplierId: target.supplier.id,
        ...(requester.kind === 'customer'
          ? { customerId: requester.id }
          : { adminId: requester.id }),
        expiresAt: new Date(Date.now() + PLAYER_CHECK_TTL_MS[result]),
      });
      return result === 'valid' ? { result, playerName, region } : { result };
    });
  }

  /** Rule PV5: the first refusal of the day tells the admin, once (its dedupe key). */
  private async quotaReached(target: CheckTarget): Promise<void> {
    const { supplier, quota } = target;
    await this.db.transaction((tx) =>
      queueTelegramMessage(tx, this.jobs, {
        kind: 'validation_quota_reached',
        params: { supplier: supplier.code, supplierNameAr: supplier.nameAr, quota },
        dedupeKey: `validation-quota:${supplier.code}:${damascusDate(new Date())}`,
      }),
    );
  }
}

/** S19 PC3: a valid answer on a region the game does not allow is `region_mismatch`. */
function withRegions(
  answer: Answer,
  allowedRegions: readonly string[],
): Answer | Extract<PlayerCheck, { result: 'region_mismatch' }> {
  if (answer.result !== 'valid' || !regionMismatch(answer.region, allowedRegions)) return answer;
  return {
    result: 'region_mismatch',
    playerName: answer.playerName,
    region: answer.region as string,
  };
}
