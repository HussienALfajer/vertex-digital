import { Inject, Injectable } from '@nestjs/common';
import {
  DEPOSIT_SETTINGS_DEFAULTS,
  earnedTierFor,
  expectedParentListId,
  LEVEL_TIERS,
  type LevelTier,
  MERCHANT_TIERS,
  type MerchantTier,
  type MerchantTierList,
  type MerchantTierView,
  ROOT_PRICE_LIST_IDS,
  TIER_NAMES_AR,
  TIER_PREVIEW_MOVERS_MAX,
  type TierGrant,
  type TierGrantEndInput,
  type TierGrantInput,
  type TierLevelInput,
  type TierPreview,
  type TierPreviewInput,
  type TierSettingsInput,
  tierGrantEndsAt,
  tierThresholdsRise,
} from '@vertex-digital/contracts';
import {
  type AdminActor,
  currentTierSettings,
  type Database,
  endTierGrant,
  grantTier,
  liveTierLevels,
  lockCustomer,
  merchantLevels,
  merchantTierSettings,
  monthsPurchases,
  newId,
  openGrantsOfTier,
  queueAllMerchantLevels,
  recordAudit,
  repriceProducts,
  routedProducts,
  type TierGrantRow,
  type TierSettingsRow,
  type Transaction,
  tierListRefs,
  tierMerchantCounts,
  tierMerchants,
  usableList,
} from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import { JobsService } from '../../core/jobs/index.js';
import { DepositSettingsService } from '../deposits/index.js';
import { coded, merchantRefusals as refusals } from './merchant-records.js';
import type { MerchantActor } from './merchants-admin.service.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** One writer of the levels at a time: the tiers' order and chain (S21 LV1, S23). */
const LEVELS_LOCK = sql`select pg_advisory_xact_lock(hashtext('merchant-levels'))`;

/** One writer of a tier's settings at a time, so a version's "before" is the one it replaces. */
const SETTINGS_LOCK = sql`select pg_advisory_xact_lock(hashtext('merchant-tier-settings'))`;

/**
 * The merchant tiers in the panel (S23 F43, ADR 0038): the four tiers with their levels, lists,
 * privileges and merchants (AD2); a tier's level (TS1, the levels' rules) and settings (TS1, TS2),
 * re-authenticated and audited; the threshold preview (AD3); the admin's grants (MG1, MG3). A
 * level change reprices every routed product (the parent cap follows the live levels, PX2) and
 * requeues every merchant's recomputation (LV6) in its transaction.
 */
@Injectable()
export class MerchantTiersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
    private readonly depositSettings: DepositSettingsService,
  ) {}

  /** `GET /api/admin/merchant-tiers`: Bronze first. */
  async list(): Promise<MerchantTierList> {
    const [levels, settings, counts, minDepositUsdUnits] = [
      await liveTierLevels(this.db),
      await currentTierSettings(this.db),
      await tierMerchantCounts(this.db),
      await this.minimumDeposit(),
    ];
    const wholesale = ROOT_PRICE_LIST_IDS.wholesale;
    const lists = await tierListRefs(this.db, [
      wholesale,
      ...levels.map((level) => level.priceListId),
    ]);
    const listRef = (id: string) => {
      const list = lists.get(id);
      if (!list) throw new Error(`Price list ${id} does not exist`);
      return {
        id: list.id,
        name: list.name,
        parentListId: list.parentListId,
        archived: list.archived,
      };
    };
    return {
      items: MERCHANT_TIERS.map((tier): MerchantTierView => {
        const level = levels.find((candidate) => candidate.tier === tier);
        return {
          tier,
          level: level
            ? {
                id: level.id,
                monthlyThresholdUsdUnits: level.monthlyThresholdUsdUnits,
                priceList: listRef(level.priceListId),
                expectedParentListId: expectedParentListId(level.tier, levels, wholesale),
              }
            : null,
          priceList:
            tier === 'bronze' ? listRef(wholesale) : level ? listRef(level.priceListId) : null,
          settings: settingsView(settings[tier]),
          merchants: counts[tier],
        };
      }),
      minDepositUsdUnits,
    };
  }

  /**
   * `PUT /api/admin/merchant-tiers/:tier/level`: creates, changes or (with null) archives the
   * tier's level. Thresholds rise with the tier (`MERCHANT_TIER_ORDER_INVALID`); a new level or a
   * new list must be an unarchived, priced custom list whose parent is the next lower live tier's
   * list (`MERCHANT_TIER_LIST_INVALID`). An archive ends the tier's open grants first (MG7).
   */
  async setLevel(
    tierParam: string,
    input: TierLevelInput,
    actor: MerchantActor,
  ): Promise<MerchantTierView> {
    const tier = levelTier(tierParam);
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(LEVELS_LOCK);
        const levels = await liveTierLevels(tx);
        const current = levels.find((level) => level.tier === tier) ?? null;
        const others = levels.filter((level) => level.tier !== tier);
        let levelId = current?.id;
        const before = current && {
          monthlyThresholdUsdUnits: current.monthlyThresholdUsdUnits,
          priceListId: current.priceListId,
        };
        if (input.level === null) {
          if (!current) return;
          await tx
            .update(merchantLevels)
            .set({ archivedAt: new Date() })
            .where(eq(merchantLevels.id, current.id));
          // MG7: the tier's grants end before the recomputations.
          for (const grant of await openGrantsOfTier(tx, tier)) {
            await lockCustomer(tx, grant.customerId);
            await endTierGrant(tx, this.context(), grant.customerId, 'tier_archived', {
              kind: 'admin',
              actor: adminActor(actor),
              reason: null,
            });
          }
        } else {
          const after = input.level;
          if (
            !tierThresholdsRise([
              ...others,
              { tier, monthlyThresholdUsdUnits: after.monthlyThresholdUsdUnits },
            ])
          ) {
            throw new CodedException(
              422,
              'MERCHANT_TIER_ORDER_INVALID',
              'Thresholds must rise with the tier',
            );
          }
          if (after.priceListId !== current?.priceListId) {
            await tierList(tx, tier, after.priceListId, others);
          }
          if (current) {
            await tx.update(merchantLevels).set(after).where(eq(merchantLevels.id, current.id));
          } else {
            levelId = newId();
            await tx
              .insert(merchantLevels)
              .values({ id: levelId, tier, nameAr: TIER_NAMES_AR[tier], ...after });
          }
        }
        await recordAudit(tx, {
          action: 'merchant_tier.level_changed',
          actorKind: 'admin',
          actorId: actor.adminId,
          channel: 'admin',
          entityType: 'merchant_level',
          entityId: levelId as string,
          ipAddress: actor.meta.ipAddress,
          userAgent: actor.meta.userAgent,
          details: { tier, before, after: input.level },
        });
        // PX2: the cap follows the live levels; every list's rows are caught up now.
        await repriceProducts(tx, {
          productIds: await routedProducts(tx),
          cause: 'list_change',
          context: routingContext(this.env),
        });
        await queueAllMerchantLevels(tx, this.jobs, 'tiers_changed');
      });
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (constraint === 'merchant_levels_tier_idx' || constraint === 'merchant_levels_name_idx') {
        throw new CodedException(409, 'MERCHANT_TIER_TAKEN', 'Another live level has the tier');
      }
      if (constraint === 'merchant_levels_threshold_idx') {
        throw new CodedException(
          422,
          'MERCHANT_TIER_ORDER_INVALID',
          'Thresholds must rise with the tier',
        );
      }
      throw coded(error);
    }
    return this.view(tier);
  }

  /**
   * `PUT /api/admin/merchant-tiers/:tier/settings` (TS1): a new version of the tier's privileges,
   * both deposit limits at least the deposit minimums.
   */
  async saveSettings(
    tierParam: string,
    input: TierSettingsInput,
    actor: MerchantActor,
  ): Promise<MerchantTierView> {
    const tier = merchantTier(tierParam);
    const minimum = await this.minimumDeposit();
    for (const field of ['perDepositUsdUnits', 'dailyDepositUsdUnits'] as const) {
      if (input[field] < minimum) throw refusals.invalid(field, 'Below the deposit minimum');
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(SETTINGS_LOCK);
      const before = (await currentTierSettings(tx))[tier];
      const id = newId();
      await tx.insert(merchantTierSettings).values({ id, tier, ...input, adminId: actor.adminId });
      await recordAudit(tx, {
        action: 'merchant_tier.settings_changed',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'merchant_tier_settings',
        entityId: id,
        ipAddress: actor.meta.ipAddress,
        userAgent: actor.meta.userAgent,
        details: { tier, before: settingsValues(before), after: input },
      });
    });
    return this.view(tier);
  }

  /**
   * `POST /api/admin/merchant-tiers/preview` (AD3), read only: per tier the merchants who would
   * earn it with the proposed thresholds (LV3 on the previous and this month), against the tiers
   * they earn now, and who would rise and fall.
   */
  async preview(input: TierPreviewInput, now = new Date()): Promise<TierPreview> {
    const merchants = await tierMerchants(this.db);
    const tiers = Object.fromEntries(
      MERCHANT_TIERS.map((tier) => [tier, { tier, now: 0, proposed: 0 }]),
    ) as Record<MerchantTier, TierPreview['tiers'][number]>;
    const rising: TierPreview['rising'] = [];
    const falling: TierPreview['falling'] = [];
    let risingTotal = 0;
    let fallingTotal = 0;
    for (const merchant of merchants) {
      const months = await monthsPurchases(this.db, merchant.customerId, now);
      const proposed = earnedTierFor(input, months.previousMonthUsdUnits, months.thisMonthUsdUnits);
      tiers[merchant.earnedTier].now += 1;
      tiers[proposed].proposed += 1;
      const mover = {
        customerId: merchant.customerId,
        tradeName: merchant.tradeName,
        from: merchant.earnedTier,
        to: proposed,
      };
      const rank = (tier: MerchantTier) => MERCHANT_TIERS.indexOf(tier);
      if (rank(proposed) > rank(merchant.earnedTier)) {
        risingTotal += 1;
        if (rising.length < TIER_PREVIEW_MOVERS_MAX) rising.push(mover);
      } else if (rank(proposed) < rank(merchant.earnedTier)) {
        fallingTotal += 1;
        if (falling.length < TIER_PREVIEW_MOVERS_MAX) falling.push(mover);
      }
    }
    return {
      tiers: MERCHANT_TIERS.map((tier) => tiers[tier]),
      rising,
      risingTotal,
      falling,
      fallingTotal,
    };
  }

  /** `POST /api/admin/customers/:id/merchant/tier-grant` (MG1). */
  async grant(customerId: string, input: TierGrantInput, actor: MerchantActor): Promise<TierGrant> {
    if (!isUuid(customerId)) throw refusals.notFound('customer');
    const now = new Date();
    const endsAt = tierGrantEndsAt(input.endsOn, now);
    if (endsAt === null) throw refusals.invalid('endsOn', 'Expected 1 to 90 days from today');
    try {
      const grant = await this.db.transaction((tx) =>
        grantTier(tx, { jobs: this.jobs, now }, customerId, {
          tier: input.tier,
          endsAt,
          reason: input.reason,
          actor: adminActor(actor),
        }),
      );
      return grantView(grant);
    } catch (error) {
      throw coded(error);
    }
  }

  /** `POST /api/admin/customers/:id/merchant/tier-grant/end` (MG3): `NOT_FOUND` with none open. */
  async endGrant(
    customerId: string,
    input: TierGrantEndInput,
    actor: MerchantActor,
  ): Promise<TierGrant> {
    if (!isUuid(customerId)) throw refusals.notFound('customer');
    try {
      const ended = await this.db.transaction(async (tx) => {
        await lockCustomer(tx, customerId);
        return endTierGrant(tx, this.context(), customerId, 'ended_by_admin', {
          kind: 'admin',
          actor: adminActor(actor),
          reason: input.reason,
        });
      });
      if (!ended) throw refusals.notFound('open grant');
      return grantView(ended);
    } catch (error) {
      throw coded(error);
    }
  }

  private context() {
    return { jobs: this.jobs, now: new Date() };
  }

  private async view(tier: MerchantTier): Promise<MerchantTierView> {
    const view = (await this.list()).items.find((item) => item.tier === tier);
    if (!view) throw refusals.notFound('tier');
    return view;
  }

  /** The highest of the Sham Cash and USDT minimums (S20 data: both limits reach it). */
  private async minimumDeposit(): Promise<number> {
    const current = (await this.depositSettings.current()) ?? DEPOSIT_SETTINGS_DEFAULTS;
    return Math.max(current.minDepositUsdUnits, current.usdtMinDepositUsdUnits);
  }
}

/** A tier of the route; an unknown one is not found. */
function merchantTier(value: string): MerchantTier {
  if (!(MERCHANT_TIERS as readonly string[]).includes(value)) throw refusals.notFound('tier');
  return value as MerchantTier;
}

/** A tier that carries a level (Bronze has none). */
function levelTier(value: string): LevelTier {
  if (!(LEVEL_TIERS as readonly string[]).includes(value)) throw refusals.notFound('tier');
  return value as LevelTier;
}

/**
 * The levels' rules: an unarchived, priced custom list (taken `FOR SHARE` against an archive, S20
 * LS5) whose parent is the next lower live tier's list, wholesale for the lowest.
 */
async function tierList(
  tx: Transaction,
  tier: LevelTier,
  priceListId: string,
  others: readonly { tier: LevelTier; priceListId: string }[],
): Promise<void> {
  const expected = expectedParentListId(tier, others, ROOT_PRICE_LIST_IDS.wholesale);
  const refuse = () =>
    new CodedException(422, 'MERCHANT_TIER_LIST_INVALID', "The tier's list does not fit", {
      expectedParentListId: expected,
    });
  if (!isUuid(priceListId)) throw refuse();
  const list = await usableList(tx, priceListId);
  if (list.kind !== 'custom' || list.parentListId !== expected) throw refuse();
}

function adminActor(actor: MerchantActor): AdminActor {
  return {
    adminId: actor.adminId,
    ipAddress: actor.meta.ipAddress,
    userAgent: actor.meta.userAgent,
  };
}

function settingsValues(row: TierSettingsRow): TierSettingsInput {
  return {
    perDepositUsdUnits: row.perDepositUsdUnits,
    dailyDepositUsdUnits: row.dailyDepositUsdUnits,
    playerChecksPerHour: row.playerChecksPerHour,
    playerChecksPerDay: row.playerChecksPerDay,
    bulkLinesMax: row.bulkLinesMax,
    orderUnitsMax: row.orderUnitsMax,
    depositPriority: row.depositPriority,
    supportPriority: row.supportPriority,
    supportReplyMinutes: row.supportReplyMinutes,
    directContact: row.directContact,
    earlyAccess: row.earlyAccess,
    fastAlerts: row.fastAlerts,
    receiptWelcome: row.receiptWelcome,
    receiptLargeLogo: row.receiptLargeLogo,
  };
}

function settingsView(row: TierSettingsRow): MerchantTierView['settings'] {
  return { ...settingsValues(row), updatedAt: row.createdAt.toISOString() };
}

export function grantView(row: TierGrantRow): TierGrant {
  return {
    id: row.id,
    tier: row.tier as LevelTier,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
  };
}
