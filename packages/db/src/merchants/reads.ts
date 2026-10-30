import {
  type MerchantApplicationStatus,
  type MerchantTier,
  NEW_ACCOUNT_DAYS,
  type PriceListKind,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import { type AnyColumn, and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { receiptSettingsOf } from '../merchant-tools/counter.js';
import {
  contentPageVersions,
  customers,
  merchantApplications,
  merchantLevels,
  merchantProfiles,
  merchantWatches,
  orders,
  priceLists,
} from '../schema/index.js';
import { monthsPurchases } from './levels.js';
import { tierGrantRows } from './tiers.js';

/*
 * Merchant reads that join the customers (S20 screens): the panel's queue and merchants list, the
 * applicant beside an application, and the merchant part of the account and of the admin profile.
 */

export interface KeysetAt {
  at: string;
  id: string;
}

/** Rows strictly after `at` in the list's order (`time` ascending or descending, then id). */
function afterKey(time: AnyColumn, id: AnyColumn, at: KeysetAt, ascending: boolean) {
  const comparison = ascending ? sql`>` : sql`<`;
  return or(
    sql`${time} ${comparison} ${at.at}::timestamptz`,
    and(sql`${time} = ${at.at}::timestamptz`, sql`${id} ${comparison} ${at.id}`),
  );
}

/**
 * MA8: the panel's queue. `under_review` lists the oldest submission first; any other status, and
 * every application, the newest first. One extra row tells the caller there is a next page.
 */
export async function applicationQueue(
  db: Executor,
  input: { status: MerchantApplicationStatus | null; after: KeysetAt | null; limit: number },
) {
  const ascending = input.status === 'under_review';
  const sharedPhone = sql<number>`(select count(*)::int from ${customers} as other
    where other.phone = ${customers.phone} and other.id <> ${customers.id})`;
  return db
    .select({
      id: merchantApplications.id,
      status: merchantApplications.status,
      tradeName: merchantApplications.tradeName,
      governorate: merchantApplications.governorate,
      activity: merchantApplications.activity,
      monthlyVolume: merchantApplications.monthlyVolume,
      submittedAt: merchantApplications.submittedAt,
      cursorAt: sql<string>`${merchantApplications.submittedAt}::text`,
      customerId: customers.id,
      name: customers.name,
      email: customers.email,
      frozen: sql<boolean>`${customers.frozenAt} is not null`,
      sharedPhone,
      newAccount: sql<boolean>`${customers.createdAt} > now() - make_interval(days => ${NEW_ACCOUNT_DAYS})`,
    })
    .from(merchantApplications)
    .innerJoin(customers, eq(customers.id, merchantApplications.customerId))
    .where(
      and(
        input.status ? eq(merchantApplications.status, input.status) : undefined,
        input.after
          ? afterKey(
              merchantApplications.submittedAt,
              merchantApplications.id,
              input.after,
              ascending,
            )
          : undefined,
      ),
    )
    .orderBy(
      ascending ? asc(merchantApplications.submittedAt) : desc(merchantApplications.submittedAt),
      ascending ? asc(merchantApplications.id) : desc(merchantApplications.id),
    )
    .limit(input.limit + 1);
}

/** The applicant's identity beside an application (the panel). */
export async function applicantOf(db: Executor, customerId: string) {
  const [row] = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      phone: customers.phone,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!row) throw new Error(`Customer ${customerId} does not exist`);
  return row;
}

/** The merchant part of `GET /api/account`; null for a customer. */
export async function accountMerchant(
  db: Executor,
  customerId: string,
): Promise<{ tradeName: string; termsAccepted: boolean } | null> {
  const [row] = await db
    .select({
      tradeName: merchantProfiles.tradeName,
      termsVersionId: merchantProfiles.termsVersionId,
    })
    .from(merchantProfiles)
    .innerJoin(customers, eq(customers.id, merchantProfiles.customerId))
    .where(and(eq(merchantProfiles.customerId, customerId), eq(customers.accountType, 'merchant')));
  return row ? { tradeName: row.tradeName, termsAccepted: row.termsVersionId !== null } : null;
}

async function brandingOf(db: Executor, customerId: string) {
  const settings = await receiptSettingsOf(db, customerId);
  return {
    showWhatsapp: settings?.showWhatsapp ?? false,
    whatsapp: settings?.whatsapp ?? null,
    logoFileId: settings?.logoFileId ?? null,
    welcomeText: settings?.welcomeText ?? null,
  };
}

/** The merchant profile on the admin's customer profile; null for an account never a merchant. */
export async function merchantProfileOf(db: Executor, customerId: string) {
  const [row] = await db
    .select({
      tradeName: merchantProfiles.tradeName,
      governorate: merchantProfiles.governorate,
      city: merchantProfiles.city,
      applicationId: merchantProfiles.applicationId,
      termsVersion: contentPageVersions.version,
      grantedAt: merchantProfiles.grantedAt,
      revokedAt: merchantProfiles.revokedAt,
      levelId: merchantLevels.id,
      levelNameAr: merchantLevels.nameAr,
      levelTier: merchantLevels.tier,
      levelArchivedAt: merchantLevels.archivedAt,
      levelSource: merchantProfiles.levelSource,
      earnedLevelId: merchantProfiles.earnedLevelId,
      levelChangedAt: merchantProfiles.levelChangedAt,
      watchCount: sql<number>`(select count(*)::int from ${merchantWatches}
        where ${merchantWatches.customerId} = ${merchantProfiles.customerId})`,
    })
    .from(merchantProfiles)
    .leftJoin(contentPageVersions, eq(contentPageVersions.id, merchantProfiles.termsVersionId))
    .leftJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.levelId))
    .where(eq(merchantProfiles.customerId, customerId));
  if (!row) return null;
  const {
    levelId,
    levelNameAr,
    levelTier,
    levelArchivedAt,
    levelSource,
    earnedLevelId,
    ...profile
  } = row;
  // S23 AD5: the effective tier (a live level of a profile not revoked), the earned one, the grants.
  const live = levelId !== null && levelArchivedAt === null && row.revokedAt === null;
  const [earned] =
    earnedLevelId === null || row.revokedAt !== null
      ? []
      : await db
          .select({ tier: merchantLevels.tier })
          .from(merchantLevels)
          .where(and(eq(merchantLevels.id, earnedLevelId), isNull(merchantLevels.archivedAt)));
  const grants = await tierGrantRows(db, customerId);
  return {
    ...profile,
    // S21 LV4: the level and the months' purchases that decide it.
    level: levelId !== null && levelNameAr !== null ? { id: levelId, nameAr: levelNameAr } : null,
    tier: {
      tier: live ? (levelTier ?? 'bronze') : ('bronze' as const),
      earnedTier: earned?.tier ?? ('bronze' as const),
      source: live ? levelSource : null,
      since: live ? row.levelChangedAt : null,
      grants,
    },
    ...(await monthsPurchases(db, customerId, new Date())),
    // S21 BR3: the receipt branding (a profile always has its settings, saved or default).
    branding: await brandingOf(db, customerId),
  };
}

/**
 * `GET /api/admin/merchants`: current merchants, newest grant first, searched by trade name, name
 * or email and filtered by their effective list, with 30 days of delivered sales net of refunds.
 */
export async function merchantPage(
  db: Executor,
  input: {
    q: string | null;
    listId: string | null;
    /** S21: a level's merchants, or `none`. */
    levelId: string | null;
    /** S23 AD1: a tier's merchants, or `granted` for a granted tier. */
    tier: MerchantTier | 'granted' | null;
    after: KeysetAt | null;
    limit: number;
  },
) {
  // S21 LV5: the assigned list, else the live level's, else wholesale.
  const effectiveList = sql<string>`coalesce(${customers.priceListId},
    case when ${merchantLevels.archivedAt} is null then ${merchantLevels.priceListId} end,
    ${ROOT_PRICE_LIST_IDS.wholesale}::uuid)`;
  const pattern = input.q
    ? `%${input.q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    : null;
  const rows = await db
    .select({
      customerId: customers.id,
      name: customers.name,
      email: customers.email,
      frozen: sql<boolean>`${customers.frozenAt} is not null`,
      tradeName: merchantProfiles.tradeName,
      governorate: merchantProfiles.governorate,
      city: merchantProfiles.city,
      termsAccepted: sql<boolean>`${merchantProfiles.termsVersionId} is not null`,
      grantedAt: merchantProfiles.grantedAt,
      cursorAt: sql<string>`${merchantProfiles.grantedAt}::text`,
      listId: priceLists.id,
      listName: priceLists.name,
      listKind: sql<PriceListKind>`${priceLists.kind}`,
      levelId: merchantLevels.id,
      levelNameAr: merchantLevels.nameAr,
      // S23 AD1: the effective tier, Bronze without a live level.
      tier: sql<MerchantTier>`case when ${merchantLevels.archivedAt} is null
        then coalesce(${merchantLevels.tier}, 'bronze') else 'bronze' end`,
      tierGranted: sql<boolean>`coalesce(${merchantLevels.archivedAt} is null
        and ${merchantProfiles.levelSource} = 'granted', false)`,
      assigned: sql<boolean>`${customers.priceListId} is not null`,
      sales30d: sql<string>`coalesce((select sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits})
        from ${orders} where ${orders.customerId} = ${customers.id}
          and ${orders.status} in ('delivered', 'partially_refunded')
          and ${orders.finishedAt} > now() - interval '30 days'), 0)::text`,
    })
    .from(merchantProfiles)
    .innerJoin(customers, eq(customers.id, merchantProfiles.customerId))
    .leftJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.levelId))
    .innerJoin(priceLists, eq(priceLists.id, effectiveList))
    .where(
      and(
        eq(customers.accountType, 'merchant'),
        isNull(merchantProfiles.revokedAt),
        // An archived account cannot sign in: it is no working merchant (audit A06-26).
        isNull(customers.archivedAt),
        input.listId ? eq(priceLists.id, input.listId) : undefined,
        input.levelId === 'none'
          ? isNull(merchantProfiles.levelId)
          : input.levelId
            ? eq(merchantProfiles.levelId, input.levelId)
            : undefined,
        input.tier === null
          ? undefined
          : input.tier === 'granted'
            ? and(
                isNull(merchantLevels.archivedAt),
                eq(merchantProfiles.levelSource, 'granted'),
                isNotNull(merchantLevels.id),
              )
            : input.tier === 'bronze'
              ? or(isNull(merchantLevels.id), isNotNull(merchantLevels.archivedAt))
              : and(eq(merchantLevels.tier, input.tier), isNull(merchantLevels.archivedAt)),
        pattern
          ? or(
              ilike(merchantProfiles.tradeName, pattern),
              ilike(customers.name, pattern),
              ilike(customers.email, pattern),
            )
          : undefined,
        input.after
          ? afterKey(merchantProfiles.grantedAt, customers.id, input.after, false)
          : undefined,
      ),
    )
    .orderBy(desc(merchantProfiles.grantedAt), desc(customers.id))
    .limit(input.limit + 1);
  return rows.map(({ levelId, levelNameAr, ...row }) => ({
    ...row,
    level: levelId !== null && levelNameAr !== null ? { id: levelId, nameAr: levelNameAr } : null,
    sales30d: Number(row.sales30d),
  }));
}

/** The list an approval chose, by name, beside the application in the panel. */
export async function approvedListOf(
  db: Executor,
  priceListId: string | null,
): Promise<{ id: string; name: string } | null> {
  if (priceListId === null) return null;
  const [row] = await db
    .select({ id: priceLists.id, name: priceLists.name })
    .from(priceLists)
    .where(eq(priceLists.id, priceListId));
  return row ?? null;
}
