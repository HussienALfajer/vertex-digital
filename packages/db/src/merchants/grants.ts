import {
  type LevelTier,
  levelFor,
  type TierGrantEndReason,
  tierOf,
  tierRank,
} from '@vertex-digital/contracts';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { type AdminActor, CustomerError, lockCustomer } from '../customers/state.js';
import { newId } from '../id.js';
import type { JobSender } from '../notifications/index.js';
import { merchantProfiles, merchantTierGrants } from '../schema/index.js';
import { queueTelegramMessage } from '../telegram/queue-telegram-message.js';
import { monthsPurchases, recomputeMerchantLevel } from './levels.js';
import { liveTierLevels, openTierGrant, type TierGrantRow } from './tiers.js';

/*
 * Manual tier grants (S23 MG1–MG7, ADR 0038): the admin grants a merchant a tier above the one they
 * earn for 1 to 90 days; a grant ends at its end (the job), early by the admin, with a revocation
 * or when its tier's level is archived. Each change locks the customer first (`FOR NO KEY UPDATE`,
 * as the recomputation), then the grant, and recomputes the merchant inline (TR6).
 */

export interface GrantTierInput {
  tier: LevelTier;
  endsAt: Date;
  reason: string;
  actor: AdminActor;
}

/**
 * MG1: grants the locked merchant a tier. Refused for an account that is not a granted merchant
 * (`NOT_MERCHANT`), a tier without a live level (`MERCHANT_TIER_UNAVAILABLE`), a tier not above the
 * earned one (`MERCHANT_TIER_GRANT_NOT_HIGHER`) and an open grant (`MERCHANT_TIER_GRANT_OPEN`). The
 * grant, its audit entry and the recomputation in the caller's transaction.
 */
export async function grantTier(
  tx: Transaction,
  context: { jobs: JobSender; now: Date },
  customerId: string,
  input: GrantTierInput,
): Promise<TierGrantRow> {
  const customer = await lockCustomer(tx, customerId);
  const [profile] = await tx
    .select({ revokedAt: merchantProfiles.revokedAt })
    .from(merchantProfiles)
    .where(eq(merchantProfiles.customerId, customerId));
  if (customer.accountType !== 'merchant' || !profile || profile.revokedAt !== null) {
    throw new CustomerError('NOT_MERCHANT', 'The customer is not a merchant');
  }
  const levels = await liveTierLevels(tx);
  if (!levels.some((level) => level.tier === input.tier)) {
    throw new CustomerError('MERCHANT_TIER_UNAVAILABLE', 'The tier has no live level', {
      tier: input.tier,
    });
  }
  const months = await monthsPurchases(tx, customerId, context.now);
  const earnedTier = tierOf(
    levelFor(levels, months.previousMonthUsdUnits, months.thisMonthUsdUnits),
  );
  if (tierRank(input.tier) <= tierRank(earnedTier)) {
    throw new CustomerError('MERCHANT_TIER_GRANT_NOT_HIGHER', 'The tier is not above the earned', {
      earnedTier,
    });
  }
  const open = await openTierGrant(tx, customerId, true);
  if (open) {
    throw new CustomerError('MERCHANT_TIER_GRANT_OPEN', 'A grant is open', { grantId: open.id });
  }
  const [grant] = await tx
    .insert(merchantTierGrants)
    .values({
      id: newId(),
      customerId,
      tier: input.tier,
      startsAt: context.now,
      endsAt: input.endsAt,
      reason: input.reason,
      adminId: input.actor.adminId,
    })
    .returning();
  const row = grant as TierGrantRow;
  await recordAudit(tx, {
    action: 'merchant.tier_granted',
    actorKind: 'admin',
    actorId: input.actor.adminId,
    channel: 'admin',
    entityType: 'customer',
    entityId: customerId,
    reason: input.reason,
    ipAddress: input.actor.ipAddress,
    userAgent: input.actor.userAgent,
    details: { grantId: row.id, tier: input.tier, endsAt: input.endsAt.toISOString() },
  });
  await recomputeMerchantLevel(tx, { ...context, cause: 'granted' }, customerId);
  return row;
}

/** Who ends a grant: the admin with a reason (MG3), or the system (MG4, MG7, TR9). */
export type GrantEnder =
  | { kind: 'admin'; actor: AdminActor; reason: string | null }
  | { kind: 'system' };

/**
 * MG3, MG4, MG7, TR9: ends the customer's open grant, locked `FOR UPDATE` after the customer
 * (which the caller locked); the audit entry, then, unless the merchant is being revoked (the
 * revocation recomputes), the recomputation inline (`grant_ended`). Null when no grant is open.
 */
export async function endTierGrant(
  tx: Transaction,
  context: { jobs: JobSender; now: Date },
  customerId: string,
  endReason: TierGrantEndReason,
  ender: GrantEnder,
): Promise<TierGrantRow | null> {
  const open = await openTierGrant(tx, customerId, true);
  if (!open) return null;
  const [ended] = await tx
    .update(merchantTierGrants)
    .set({ endedAt: context.now, endReason })
    .where(eq(merchantTierGrants.id, open.id))
    .returning();
  await recordAudit(tx, {
    action: 'merchant.tier_grant_ended',
    ...(ender.kind === 'admin'
      ? {
          actorKind: 'admin',
          actorId: ender.actor.adminId,
          channel: 'admin',
          reason: ender.reason,
          ipAddress: ender.actor.ipAddress,
          userAgent: ender.actor.userAgent,
        }
      : { actorKind: 'system', actorId: null, channel: 'worker' }),
    entityType: 'customer',
    entityId: customerId,
    details: { grantId: open.id, tier: open.tier as LevelTier, endReason },
  });
  if (endReason !== 'merchant_revoked') {
    await recomputeMerchantLevel(tx, { ...context, cause: 'grant_ended' }, customerId);
  }
  return ended as TierGrantRow;
}

/** MG4: the open grants past their end, oldest end first. */
export async function dueTierGrants(db: Executor, now: Date): Promise<TierGrantRow[]> {
  return db
    .select()
    .from(merchantTierGrants)
    .where(and(isNull(merchantTierGrants.endedAt), lte(merchantTierGrants.endsAt, now)))
    .orderBy(asc(merchantTierGrants.endsAt), asc(merchantTierGrants.id));
}

/**
 * MG4: ends one due grant in the caller's transaction (`expired`): the customer, then the grant,
 * re-read under the locks; false when it was ended meanwhile or is not due.
 */
export async function expireTierGrant(
  tx: Transaction,
  context: { jobs: JobSender; now: Date },
  grant: Pick<TierGrantRow, 'id' | 'customerId'>,
): Promise<boolean> {
  await lockCustomer(tx, grant.customerId);
  const open = await openTierGrant(tx, grant.customerId, true);
  if (!open || open.id !== grant.id || open.endsAt > context.now) return false;
  await endTierGrant(tx, context, grant.customerId, 'expired', { kind: 'system' });
  return true;
}

/**
 * MG5: one Telegram reminder per open grant ending within 3 days (dedupe key
 * `grant-ending:<grant>`), naming the tier the merchant returns to. Returns the reminders written.
 */
export async function remindEndingTierGrants(
  tx: Transaction,
  context: { jobs: JobSender; now: Date },
): Promise<number> {
  const ending = await tx
    .select({ grant: merchantTierGrants, tradeName: merchantProfiles.tradeName })
    .from(merchantTierGrants)
    .innerJoin(merchantProfiles, eq(merchantProfiles.customerId, merchantTierGrants.customerId))
    .where(
      and(
        isNull(merchantTierGrants.endedAt),
        gt(merchantTierGrants.endsAt, context.now),
        lte(
          merchantTierGrants.endsAt,
          sql`${context.now.toISOString()}::timestamptz + interval '3 days'`,
        ),
      ),
    )
    .orderBy(asc(merchantTierGrants.endsAt), asc(merchantTierGrants.id));
  if (ending.length === 0) return 0;
  const levels = await liveTierLevels(tx);
  let written = 0;
  for (const { grant, tradeName } of ending) {
    const months = await monthsPurchases(tx, grant.customerId, context.now);
    const earned = levelFor(levels, months.previousMonthUsdUnits, months.thisMonthUsdUnits);
    const id = await queueTelegramMessage(tx, context.jobs, {
      kind: 'merchant_tier_grant_ending',
      params: {
        customerId: grant.customerId,
        tradeName,
        tier: grant.tier as LevelTier,
        endsAt: grant.endsAt.toISOString(),
        earnedTier: tierOf(earned),
      },
      dedupeKey: `grant-ending:${grant.id}`,
    });
    if (id !== null) written += 1;
  }
  return written;
}
