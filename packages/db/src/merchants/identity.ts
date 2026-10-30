import { randomBytes } from 'node:crypto';
import {
  damascusMonth,
  type MerchantTier,
  monthRange,
  ROOT_PRICE_LIST_IDS,
  type TierReminder,
  tierReminder,
} from '@vertex-digital/contracts';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { lockCustomer } from '../customers/state.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import {
  catalogGames,
  catalogProducts,
  customerNotifications,
  customers,
  merchantLevels,
  merchantProfiles,
  merchantTierMonths,
  orders,
  productPrices,
} from '../schema/index.js';
import { monthsPurchases } from './levels.js';
import { liveTierLevels, merchantTier } from './tiers.js';

/*
 * S23 identity and progress (ID3, ID4, ID7, PG2, PG5, PG6): the merchant's tier reads and the
 * certificate. Reads only, but the celebration flag and the certificate code, which the merchant
 * changes for themself.
 */

/** ID3, ID7: what the tier card and the certificate read of a merchant's profile. */
export async function tierProfileOf(db: Executor, customerId: string) {
  const [row] = await db
    .select({
      tradeName: merchantProfiles.tradeName,
      city: merchantProfiles.city,
      governorate: merchantProfiles.governorate,
      grantedAt: merchantProfiles.grantedAt,
      revokedAt: merchantProfiles.revokedAt,
      levelChangedAt: merchantProfiles.levelChangedAt,
      levelSource: merchantProfiles.levelSource,
      earnedTier: merchantLevels.tier,
      earnedArchivedAt: merchantLevels.archivedAt,
      celebratePending: merchantProfiles.celebratePending,
      certificateCode: merchantProfiles.certificateCode,
      certificateReissuedAt: merchantProfiles.certificateReissuedAt,
    })
    .from(merchantProfiles)
    .leftJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.earnedLevelId))
    .where(eq(merchantProfiles.customerId, customerId));
  if (!row) return null;
  const earnedTier: MerchantTier =
    row.earnedArchivedAt === null && row.earnedTier !== null ? row.earnedTier : 'bronze';
  /** ID3: since the effective tier last changed, or since the grant for a merchant never moved. */
  const since = row.levelChangedAt ?? row.grantedAt;
  return { ...row, earnedTier, since };
}

/**
 * PG6: what the merchant's tier saved in `month` (`YYYY-MM`): over the orders charged at a tier's
 * list and delivered in the month, Σ delivered units × (the wholesale price in force at the order's
 * creation − the unit price paid), each order floored at zero (edge case 18).
 */
export async function tierSavings(
  db: Executor,
  customerId: string,
  month: string,
): Promise<number> {
  const range = monthRange(month);
  const [row] = await db
    .select({
      saved: sql<string>`coalesce(sum(greatest(0,
        (${sql`wholesale.price_usd_units`} - ${orders.unitPriceUsdUnits}) * ${orders.deliveredQuantity})), 0)::text`,
    })
    .from(orders)
    .innerJoinLateral(
      db
        .select({ price_usd_units: productPrices.priceUsdUnits })
        .from(productPrices)
        .where(
          and(
            eq(productPrices.productId, orders.productId),
            eq(productPrices.priceListId, ROOT_PRICE_LIST_IDS.wholesale),
            sql`${productPrices.createdAt} <= ${orders.createdAt}`,
          ),
        )
        .orderBy(desc(productPrices.createdAt), desc(productPrices.id))
        .limit(1)
        .as('wholesale'),
      sql`true`,
    )
    .where(
      and(
        eq(orders.customerId, customerId),
        sql`${orders.deliveredQuantity} > 0`,
        gte(orders.finishedAt, range.start),
        lt(orders.finishedAt, range.end),
        sql`${orders.priceListId} in (select ${merchantLevels.priceListId} from ${merchantLevels})`,
      ),
    );
  return Number(row?.saved ?? 0);
}

/** PG2: three packs at most. */
const TABLE_PACKS = 3;

/**
 * PG2: the merchant's three most-bought packs (delivered units in 90 days); with none, the three
 * packs merchants bought most in 30 days. Live packs of live games only.
 */
export async function tierTablePacks(
  db: Executor,
  customerId: string,
  now: Date,
): Promise<{ productId: string; gameNameAr: string; nameAr: string }[]> {
  const read = (days: number, own: boolean) =>
    db
      .select({
        productId: catalogProducts.id,
        gameNameAr: catalogGames.nameAr,
        nameAr: catalogProducts.nameAr,
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
      .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
      .where(
        and(
          own ? eq(orders.customerId, customerId) : eq(customers.accountType, 'merchant'),
          eq(orders.payer, 'customer'),
          sql`${orders.deliveredQuantity} > 0`,
          gte(orders.createdAt, new Date(now.getTime() - days * 86_400_000)),
          isNull(catalogProducts.archivedAt),
          isNull(catalogGames.archivedAt),
        ),
      )
      .groupBy(catalogProducts.id, catalogGames.nameAr, catalogProducts.nameAr)
      .orderBy(desc(sql`sum(${orders.deliveredQuantity})`), catalogProducts.id)
      .limit(TABLE_PACKS);
  const own = await read(90, true);
  return own.length > 0 ? own : read(30, false);
}

/** PG5: the months written by the monthly schedule, newest first. */
export function tierMonthRows(db: Executor, customerId: string) {
  return db
    .select({
      month: merchantTierMonths.month,
      netPurchasesUsdUnits: merchantTierMonths.netPurchasesUsdUnits,
      heldTier: merchantTierMonths.heldTier,
    })
    .from(merchantTierMonths)
    .where(eq(merchantTierMonths.customerId, customerId))
    .orderBy(desc(merchantTierMonths.month));
}

/** ID9: the row of one month (`YYYY-MM`), or null before the history starts. */
export async function tierMonthOf(db: Executor, customerId: string, month: string) {
  const [row] = await db
    .select()
    .from(merchantTierMonths)
    .where(
      and(
        eq(merchantTierMonths.customerId, customerId),
        eq(merchantTierMonths.month, `${month}-01`),
      ),
    );
  return row ?? null;
}

/** ID4: the merchant saw the celebration. */
export async function clearCelebration(db: Executor, customerId: string): Promise<void> {
  await db
    .update(merchantProfiles)
    .set({ celebratePending: false })
    .where(
      and(eq(merchantProfiles.customerId, customerId), eq(merchantProfiles.celebratePending, true)),
    );
}

/**
 * ID7: a new certificate code (16 CSPRNG bytes, base64url) in the caller's transaction, the
 * customer locked; old prints stop resolving. Audited `merchant.certificate_reissued`.
 */
export async function reissueCertificate(
  tx: Transaction,
  customerId: string,
  actor: { ipAddress: string | null; userAgent: string | null },
  now: Date,
): Promise<void> {
  await lockCustomer(tx, customerId);
  await tx
    .update(merchantProfiles)
    .set({ certificateCode: randomBytes(16).toString('base64url'), certificateReissuedAt: now })
    .where(eq(merchantProfiles.customerId, customerId));
  await recordAudit(tx, {
    action: 'merchant.certificate_reissued',
    actorKind: 'customer',
    actorId: customerId,
    channel: 'store',
    entityType: 'customer',
    entityId: customerId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    details: {},
  });
}

/**
 * ID7 (`GET /api/certificates/:code`): the trade name, place and current tier by the code, or
 * `revoked` for a merchant no longer approved (revoked, or the account closed); null for an
 * unknown code. A frozen merchant still shows their tier (edge case 16).
 */
export async function certificateByCode(db: Executor, code: string) {
  const [row] = await db
    .select({
      customerId: merchantProfiles.customerId,
      tradeName: merchantProfiles.tradeName,
      city: merchantProfiles.city,
      governorate: merchantProfiles.governorate,
      revokedAt: merchantProfiles.revokedAt,
      archivedAt: customers.archivedAt,
      levelChangedAt: merchantProfiles.levelChangedAt,
      grantedAt: merchantProfiles.grantedAt,
    })
    .from(merchantProfiles)
    .innerJoin(customers, eq(customers.id, merchantProfiles.customerId))
    .where(eq(merchantProfiles.certificateCode, code));
  if (!row) return null;
  // A closed (archived) account is no longer approved, as a revoked one (reviewer, S23 PR 2).
  const approved = row.revokedAt === null && row.archivedAt === null;
  const tier = approved ? await merchantTier(db, row.customerId) : null;
  if (tier === null) return { status: 'revoked' as const };
  return {
    status: 'active' as const,
    tradeName: row.tradeName,
    city: row.city,
    governorate: row.governorate,
    tier,
    since: (row.levelChangedAt ?? row.grantedAt).toISOString(),
  };
}

/** PG3: the merchants a month-end reminder may go to: not frozen, not archived. */
export async function tierReminderMerchants(db: Executor): Promise<string[]> {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .innerJoin(merchantProfiles, eq(merchantProfiles.customerId, customers.id))
    .where(
      and(
        eq(customers.accountType, 'merchant'),
        isNull(customers.frozenAt),
        isNull(customers.archivedAt),
        isNull(merchantProfiles.revokedAt),
      ),
    )
    .orderBy(customers.id);
  return rows.map((row) => row.id);
}

/**
 * PG3 for one merchant at `now`: `merchant_tier_reminder` once per month when `tierReminder` gives
 * one on the earned tier (the dedupe key `tier-reminder:<customer>:<month>` as an advisory lock,
 * then a notification of that month already written means sent). Returns the reminder sent, or
 * null.
 */
export async function sendTierReminder(
  tx: Transaction,
  jobs: JobSender,
  customerId: string,
  now: Date,
): Promise<TierReminder | null> {
  const month = damascusMonth(now);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`tier-reminder:${customerId}:${month}`}))`,
  );
  const [sent] = await tx
    .select({ id: customerNotifications.id })
    .from(customerNotifications)
    .where(
      and(
        eq(customerNotifications.customerId, customerId),
        eq(customerNotifications.event, 'merchant_tier_reminder'),
        sql`${customerNotifications.params}->>'month' = ${month}`,
      ),
    )
    .limit(1);
  if (sent) return null;
  const profile = await tierProfileOf(tx, customerId);
  if (!profile || profile.revokedAt !== null) return null;
  const levels = await liveTierLevels(tx);
  const months = await monthsPurchases(tx, customerId, now);
  const reminder = tierReminder(
    levels,
    months.previousMonthUsdUnits,
    months.thisMonthUsdUnits,
    profile.earnedTier,
  );
  if (!reminder) return null;
  await notifyCustomer(tx, jobs, {
    customerId,
    event: 'merchant_tier_reminder',
    params: { ...reminder, month },
  });
  return reminder;
}
