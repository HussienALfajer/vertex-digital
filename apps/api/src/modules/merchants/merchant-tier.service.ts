import { Inject, Injectable } from '@nestjs/common';
import {
  CERTIFICATE_REISSUES_PER_DAY,
  certificateCodeSchema,
  damascusMonth,
  MERCHANT_TIERS,
  type MerchantCertificate,
  type MerchantTier,
  type MerchantTierHistory,
  type MerchantTierSummary,
  type MerchantTierTable,
  type PublicCertificate,
  ROOT_PRICE_LIST_IDS,
  tierForecast,
  tierKeptUntil,
  tierProgress,
  zoneDate,
} from '@vertex-digital/contracts';
import {
  accountPriceList,
  applicant,
  certificateByCode,
  clearCelebration,
  currentTierSettings,
  type Database,
  liveTierLevels,
  merchantTier,
  monthsPurchases,
  newestListPrices,
  readAll,
  reissueCertificate,
  tierMonthRows,
  tierPrivileges,
  tierProfileOf,
  tierSavings,
  tierTablePacks,
  withinLimits,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';

const DAY = 24 * 60 * 60 * 1000;

const refusals = {
  notMerchant: () => new CodedException(403, 'NOT_MERCHANT', 'The account is not a merchant'),
  frozen: () => new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen'),
  notFound: () => new CodedException(404, 'NOT_FOUND', 'No such certificate'),
  reissueLimit: () =>
    new CodedException(
      429,
      'CERTIFICATE_REISSUE_LIMIT',
      'The certificate was reissued 3 times today',
    ),
};

/**
 * The merchant's tier (S23 ID3, ID4, ID7, PG1–PG7): the tier card, the tier table, the history,
 * the celebration and the certificate, for the merchant only (frozen ones read); and the public
 * certificate page. Never the tier's source (decision 13), a list's name, rule or cost.
 */
@Injectable()
export class MerchantTierService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** A merchant's account, frozen allowed for reads; `write` refuses a frozen one. */
  private async merchant(customerId: string, write = false) {
    const person = await applicant(this.db, customerId);
    if (person?.accountType !== 'merchant') throw refusals.notMerchant();
    if (write && (person.frozenAt !== null || person.archivedAt !== null)) throw refusals.frozen();
    const profile = await tierProfileOf(this.db, customerId);
    const tier = await merchantTier(this.db, customerId);
    if (!profile || tier === null) throw refusals.notMerchant();
    return { profile, tier };
  }

  /** `GET /api/merchant/tier` (ID3, PG1, PG4, PG6, TR7). */
  async summary(customerId: string, now = new Date()): Promise<MerchantTierSummary> {
    const { profile, tier } = await this.merchant(customerId);
    const month = damascusMonth(now);
    const [levels, months, settings, pricing] = await readAll(this.db, [
      () => liveTierLevels(this.db),
      () => monthsPurchases(this.db, customerId, now),
      () => currentTierSettings(this.db),
      () => accountPriceList(this.db, customerId),
    ]);
    const progress = tierProgress(levels, months.thisMonthUsdUnits, tier);
    const day = Number(zoneDate(now).slice(8, 10));
    const daysInMonth = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
    ).getUTCDate();
    // TR7: the keep line is hidden while a grant sets the tier above the earned one.
    const keptUntil =
      profile.levelSource === 'earned'
        ? tierKeptUntil(levels, months.thisMonthUsdUnits, profile.earnedTier, month)
        : null;
    // PG6: only an account priced by a tier's list saves (edge case 1).
    const tierPriced = levels.some((level) => level.priceListId === pricing?.effectiveList.id);
    return {
      tier,
      since: profile.since.toISOString(),
      keptUntil,
      month,
      thisMonthUsdUnits: months.thisMonthUsdUnits,
      progress,
      forecast: tierForecast(
        months.thisMonthUsdUnits,
        day,
        daysInMonth,
        progress.next?.thresholdUsdUnits ?? null,
      ),
      savingsUsdUnits: tierPriced ? await tierSavings(this.db, customerId, month) : null,
      privileges: tierPrivileges(settings[tier]),
      celebrate: profile.celebratePending,
    };
  }

  /** `GET /api/merchant/tier/table` (PG2, decision 8): three packs' prices on each tier's list. */
  async table(customerId: string, now = new Date()): Promise<MerchantTierTable> {
    const { tier } = await this.merchant(customerId);
    const [levels, settings, packs] = await readAll(this.db, [
      () => liveTierLevels(this.db),
      () => currentTierSettings(this.db),
      () => tierTablePacks(this.db, customerId, now),
    ]);
    const productIds = packs.map((pack) => pack.productId);
    const tiers: MerchantTierTable['tiers'] = [];
    for (const each of MERCHANT_TIERS) {
      const level = levels.find((candidate) => candidate.tier === each);
      const listId = each === 'bronze' ? ROOT_PRICE_LIST_IDS.wholesale : level?.priceListId;
      const rows =
        listId && productIds.length > 0 ? await newestListPrices(this.db, productIds, listId) : [];
      tiers.push({
        tier: each,
        available: each === 'bronze' || level !== undefined,
        thresholdUsdUnits: level?.monthlyThresholdUsdUnits ?? null,
        privileges: tierPrivileges(settings[each]),
        prices: productIds.map(
          (id) => rows.find((row) => row.productId === id)?.priceUsdUnits ?? null,
        ),
      });
    }
    return { current: tier, packs, tiers };
  }

  /** `GET /api/merchant/tier/history` (PG5): this month live on top, then the written months. */
  async history(customerId: string, now = new Date()): Promise<MerchantTierHistory> {
    const { tier } = await this.merchant(customerId);
    const month = damascusMonth(now);
    const [rows, months] = await readAll(this.db, [
      () => tierMonthRows(this.db, customerId),
      () => monthsPurchases(this.db, customerId, now),
    ]);
    return {
      items: [
        { month, netPurchasesUsdUnits: months.thisMonthUsdUnits, tier, current: true },
        ...rows
          .map((row) => ({
            month: row.month.slice(0, 7),
            netPurchasesUsdUnits: row.netPurchasesUsdUnits,
            tier: row.heldTier as MerchantTier,
            current: false,
          }))
          .filter((row) => row.month !== month),
      ],
    };
  }

  /** `POST /api/merchant/tier/celebrated` (ID4). */
  async celebrated(customerId: string): Promise<void> {
    await this.merchant(customerId, true);
    await clearCelebration(this.db, customerId);
  }

  /** `GET /api/merchant/certificate` (ID7). */
  async certificate(customerId: string): Promise<MerchantCertificate> {
    const { profile, tier } = await this.merchant(customerId);
    return {
      code: profile.certificateCode,
      tradeName: profile.tradeName,
      city: profile.city,
      governorate: profile.governorate,
      tier,
      since: profile.since.toISOString(),
      reissuedAt: profile.certificateReissuedAt?.toISOString() ?? null,
    };
  }

  /** `POST /api/merchant/certificate/reissue` (ID7): 3 a day; old prints stop resolving. */
  async reissue(customerId: string, meta: RequestMeta): Promise<MerchantCertificate> {
    await this.merchant(customerId, true);
    const allowed = await withinLimits(this.db, [
      {
        key: `certificate-reissue:customer:${customerId}`,
        max: CERTIFICATE_REISSUES_PER_DAY,
        windowMs: DAY,
      },
    ]);
    if (!allowed) throw refusals.reissueLimit();
    await this.db.transaction((tx) => reissueCertificate(tx, customerId, meta, new Date()));
    return this.certificate(customerId);
  }

  /** `GET /api/certificates/:code` (ID7): an unknown or malformed code is not found (as VF3). */
  async publicCertificate(code: string): Promise<PublicCertificate> {
    if (!certificateCodeSchema.safeParse(code).success) throw refusals.notFound();
    const found = await certificateByCode(this.db, code);
    if (!found) throw refusals.notFound();
    return found;
  }
}
