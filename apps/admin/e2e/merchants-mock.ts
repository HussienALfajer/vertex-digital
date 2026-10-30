import {
  type AdminCustomer,
  type AdminMerchantApplication,
  type AdminMerchantApplicationRow,
  type AdminMerchantRow,
  type AdminMerchantTier,
  type ApplicationAction,
  applicationTransition,
  earnedTierFor,
  expectedParentListId,
  type Governorate,
  grantMerchantSchema,
  LEVEL_TIERS,
  type LevelTier,
  MERCHANT_SETTINGS_DEFAULTS,
  MERCHANT_TIERS,
  type MerchantApplicationEventKind,
  type MerchantSettings,
  type MerchantTier,
  type MerchantTierView,
  merchantMessageSchema,
  merchantSettingsInputSchema,
  priceKindOf,
  ROOT_PRICE_LIST_IDS,
  removeMerchantLogoSchema,
  removeWelcomeTextSchema,
  revokeMerchantSchema,
  TIER_LIST_NAMES,
  TIER_SETTINGS_DEFAULTS,
  TIER_THRESHOLD_DEFAULTS,
  type TierGrant,
  type TierSettings,
  tierGrantEndInputSchema,
  tierGrantEndsAt,
  tierGrantInputSchema,
  tierLevelInputSchema,
  tierPreviewInputSchema,
  tierRank,
  tierSettingsInputSchema,
  tierThresholdsRise,
} from '@vertex-digital/contracts';
import { type Answer, nextId } from './catalog-mock';
import type { PriceListsMock } from './price-lists-mock';

/*
 * Merchants of S20 PR 3 as the panel sees them: applications moved on the contracts'
 * `applicationTransition` (MA4), approvals and direct grants that make the account a merchant on
 * its list (MA5, MA6), revocations (MA7), the merchants list and the settings; S23: the tiers with
 * their levels on chained lists (`setupTiers`, as the production setup does), their privileges with
 * the deposit minimum check, the threshold preview and the manual grants. `seedApplication` adds an
 * application for a test, `setMonths` a merchant's net purchases.
 */

type Body = Record<string, unknown> | null;

const NOW = () => new Date().toISOString();
const USD = 1_000_000;
/** The highest deposit minimum of the deposit settings' defaults (USDT $5). */
const MIN_DEPOSIT = 5 * USD;

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

interface MockMerchantCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  frozenAt: string | null;
  archivedAt: string | null;
}

interface StoredProfile {
  tradeName: string;
  governorate: Governorate;
  city: string;
  applicationId: string | null;
  termsVersion: number | null;
  grantedAt: string;
  revokedAt: string | null;
  /** S21 LV4: the effective level (S23: its tier's). */
  level: { id: string; nameAr: string } | null;
  levelChangedAt: string | null;
  /** S23 AD5: the tier, Bronze by default. */
  tier: AdminMerchantTier;
  thisMonthUsdUnits: number;
  previousMonthUsdUnits: number;
  watchCount: number;
  /** S21 BR3: the receipt branding; a test sets a logo with `setBranding`. */
  branding: {
    showWhatsapp: boolean;
    whatsapp: string | null;
    logoFileId: string | null;
    welcomeText: string | null;
  };
}

const EVENTS: Record<ApplicationAction, MerchantApplicationEventKind> = {
  request_info: 'info_requested',
  resubmit: 'resubmitted',
  approve: 'approved',
  reject: 'rejected',
  withdraw: 'withdrawn',
  expire: 'expired',
  grant: 'approved',
};

export class MerchantsMock {
  applications: AdminMerchantApplication[] = [];
  readonly profiles = new Map<string, StoredProfile>();
  settings: MerchantSettings = {
    ...MERCHANT_SETTINGS_DEFAULTS,
    updatedAt: '2026-10-20T09:00:00.000Z',
  };
  /** S23 TS1: each tier's privileges in force. */
  tierSettings = Object.fromEntries(
    MERCHANT_TIERS.map((tier) => [
      tier,
      { ...TIER_SETTINGS_DEFAULTS[tier], updatedAt: '2026-10-20T09:00:00.000Z' },
    ]),
  ) as Record<MerchantTier, TierSettings>;
  /** S23 TR1: the live level of each tier above Bronze. */
  levels: Partial<
    Record<LevelTier, { id: string; monthlyThresholdUsdUnits: number; priceListId: string }>
  > = {};

  constructor(
    private readonly reauthenticationRequired: () => boolean,
    private readonly customer: (id: string) => MockMerchantCustomer | null,
    private readonly priceLists: PriceListsMock,
    private readonly profile: (customerId: string) => AdminCustomer | null,
  ) {}

  /** S21 BR3: the merchant's receipt branding, for a test. */
  setBranding(customerId: string, branding: Partial<StoredProfile['branding']>): void {
    const profile = this.profiles.get(customerId);
    if (profile) profile.branding = { ...profile.branding, ...branding };
  }

  /** A merchant now (MA5–MA7). */
  isMerchant(customerId: string): boolean {
    const profile = this.profiles.get(customerId);
    return !!profile && profile.revokedAt === null;
  }

  /** The profile's merchant part. */
  profileOf(customerId: string): AdminCustomer['merchant'] {
    return this.profiles.get(customerId) ?? null;
  }

  /** An application under review of `customerId`, as a customer would have sent it. */
  seedApplication(
    customerId: string,
    changes: Partial<AdminMerchantApplication> = {},
  ): AdminMerchantApplication {
    const person = this.customer(customerId);
    if (!person) throw new Error(`No customer ${customerId}`);
    const submittedAt = changes.submittedAt ?? NOW();
    const application: AdminMerchantApplication = {
      id: nextId(),
      status: 'under_review',
      tradeName: 'محل النور للاتصالات',
      activity: 'phone_shop',
      activityOther: null,
      yearsInBusiness: '1_3',
      governorate: 'aleppo',
      city: 'اعزاز',
      streetAddress: 'شارع السوق، قرب الجامع الكبير',
      whatsapp: person.phone,
      telegramUsername: 'nour_shop',
      monthlyVolume: '500_2000',
      productInterests: ['game_topups', 'gift_cards'],
      salesChannels: ['shop_counter', 'whatsapp_telegram'],
      shopPhotoFileId: nextId(),
      shopLink: 'https://instagram.com/nour.shop',
      heardFrom: 'friend_or_shop',
      adminMessage: null,
      submittedAt,
      infoRequestedAt: null,
      expiresAt: null,
      decidedAt: null,
      events: [{ event: 'submitted', message: null, createdAt: submittedAt }],
      customer: { id: person.id, name: person.name, email: person.email, phone: person.phone },
      termsVersion: 1,
      approvedPriceList: null,
      earlier: [],
      ...changes,
    };
    this.applications = [application, ...this.applications];
    return application;
  }

  /** The customer's answer to a request for information (MA4), as the store would send it. */
  resubmit(applicationId: string): void {
    const application = this.applications.find((row) => row.id === applicationId);
    if (application) this.move(application, 'resubmit', null);
  }

  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;

    if (key === 'GET /api/admin/merchant-applications') {
      const status = url.searchParams.get('status');
      const rows = this.applications
        .filter((row) => !status || row.status === status)
        .sort((a, b) =>
          status === 'under_review'
            ? a.submittedAt.localeCompare(b.submittedAt)
            : b.submittedAt.localeCompare(a.submittedAt),
        );
      return { status: 200, json: { items: rows.map((row) => this.row(row)), nextCursor: null } };
    }
    const one = path.match(/^\/api\/admin\/merchant-applications\/([^/]+)(\/[a-z-]+)?$/);
    if (one) {
      const application = this.applications.find((row) => row.id === one[1]);
      if (!application) return error(404, 'NOT_FOUND');
      const action = one[2];
      if (method === 'GET' && !action) return { status: 200, json: this.detail(application) };
      if (method === 'GET' && action === '/photo') return { status: 200, image: true };
      if (method === 'POST' && (action === '/request-info' || action === '/reject')) {
        const message = merchantMessageSchema.safeParse(
          action === '/reject' ? body?.reason : body?.message,
        );
        if (!message.success) return error(400, 'VALIDATION_FAILED');
        return this.move(
          application,
          action === '/reject' ? 'reject' : 'request_info',
          message.data,
        );
      }
      if (method === 'POST' && action === '/approve') {
        const refused = sensitive();
        if (refused) return refused;
        if (applicationTransition(application.status, 'approve') === null) {
          return error(409, 'APPLICATION_STATE_INVALID', { status: application.status });
        }
        const person = this.customer(application.customer.id);
        if (person?.frozenAt || person?.archivedAt) {
          return error(409, 'CUSTOMER_STATE_INVALID', { status: 'frozen' });
        }
        const listId = typeof body?.priceListId === 'string' ? body.priceListId : null;
        this.grant(application.customer.id, {
          tradeName: application.tradeName,
          governorate: application.governorate,
          city: application.city,
          applicationId: application.id,
          termsVersion: application.termsVersion,
          listId,
        });
        return this.move(application, 'approve', null);
      }
    }
    if (key === 'GET /api/admin/merchants') {
      const q = url.searchParams.get('q');
      const listId = url.searchParams.get('listId');
      const tier = url.searchParams.get('tier');
      const rows = [...this.profiles.entries()]
        .filter(([customerId]) => this.isMerchant(customerId))
        .map(([customerId, profile]) => this.merchantRow(customerId, profile))
        .filter((row) => !listId || row.priceList.id === listId)
        .filter((row) => !tier || (tier === 'granted' ? row.tierGranted : row.tier === tier))
        .filter((row) => !q || row.tradeName.includes(q) || row.name.includes(q));
      return { status: 200, json: { items: rows, nextCursor: null } };
    }
    // S21 BR3: the logo's preview and its removal (a reason, re-authentication).
    const logo = path.match(/^\/api\/admin\/customers\/([^/]+)\/merchant\/logo$/);
    if (logo) {
      const profile = this.profiles.get(logo[1] as string);
      if (!profile?.branding.logoFileId) return error(404, 'NOT_FOUND');
      if (method === 'GET') return { status: 200, image: true };
      if (method === 'DELETE') {
        const refused = sensitive();
        if (refused) return refused;
        if (!removeMerchantLogoSchema.safeParse(body).success) {
          return error(400, 'VALIDATION_FAILED');
        }
        profile.branding = { ...profile.branding, logoFileId: null };
        return { status: 204 };
      }
    }
    // S23 RC1: the welcome line's removal (a reason, re-authentication).
    const welcome = path.match(/^\/api\/admin\/customers\/([^/]+)\/merchant\/welcome-text$/);
    if (welcome && method === 'DELETE') {
      const profile = this.profiles.get(welcome[1] as string);
      if (!profile?.branding.welcomeText) return error(404, 'NOT_FOUND');
      const refused = sensitive();
      if (refused) return refused;
      if (!removeWelcomeTextSchema.safeParse(body).success) return error(400, 'VALIDATION_FAILED');
      profile.branding = { ...profile.branding, welcomeText: null };
      return { status: 204 };
    }
    const grant = path.match(/^\/api\/admin\/customers\/([^/]+)\/merchant(\/revoke)?$/);
    if (grant && method === 'POST') {
      const refused = sensitive();
      if (refused) return refused;
      const customerId = grant[1] as string;
      if (grant[2]) {
        if (!revokeMerchantSchema.safeParse(body).success) return error(400, 'VALIDATION_FAILED');
        if (!this.isMerchant(customerId)) return error(409, 'NOT_MERCHANT');
        const profile = this.profiles.get(customerId) as StoredProfile;
        profile.revokedAt = NOW();
        this.priceLists.assign(customerId, null);
        return { status: 200, json: this.profile(customerId) };
      }
      const parsed = grantMerchantSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      if (this.isMerchant(customerId)) return error(409, 'ALREADY_MERCHANT');
      this.grant(customerId, {
        tradeName: parsed.data.tradeName,
        governorate: parsed.data.governorate,
        city: parsed.data.city,
        applicationId: null,
        termsVersion: null,
        listId: parsed.data.priceListId ?? null,
      });
      const open = this.applications.find(
        (row) =>
          row.customer.id === customerId &&
          (row.status === 'under_review' || row.status === 'info_requested'),
      );
      if (open) this.move(open, 'grant', null);
      return { status: 200, json: this.profile(customerId) };
    }
    if (key === 'GET /api/admin/merchant-tiers') {
      return { status: 200, json: { items: this.tierRows(), minDepositUsdUnits: MIN_DEPOSIT } };
    }
    if (key === 'POST /api/admin/merchant-tiers/preview') {
      const parsed = tierPreviewInputSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      return { status: 200, json: this.preview(parsed.data) };
    }
    const tierRoute = path.match(/^\/api\/admin\/merchant-tiers\/([a-z]+)\/(level|settings)$/);
    if (tierRoute && method === 'PUT') {
      const tier = MERCHANT_TIERS.find((value) => value === tierRoute[1]);
      if (!tier) return error(404, 'NOT_FOUND');
      const refused = sensitive();
      if (refused) return refused;
      return tierRoute[2] === 'level'
        ? this.setLevel(tier, body)
        : this.saveTierSettings(tier, body);
    }
    const tierGrant = path.match(
      /^\/api\/admin\/customers\/([^/]+)\/merchant\/tier-grant(\/end)?$/,
    );
    if (tierGrant && method === 'POST') {
      const refused = sensitive();
      if (refused) return refused;
      return tierGrant[2]
        ? this.endGrant(tierGrant[1] as string, body)
        : this.grantTier(tierGrant[1] as string, body);
    }
    if (key === 'GET /api/admin/merchant-settings') return { status: 200, json: this.settings };
    if (key === 'PUT /api/admin/merchant-settings') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = merchantSettingsInputSchema.safeParse(body);
      if (!parsed.success) {
        return error(
          400,
          'VALIDATION_FAILED',
          parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        );
      }
      this.settings = { ...this.settings, ...parsed.data, updatedAt: NOW() };
      return { status: 200, json: this.settings };
    }
    return null;
  }

  private grant(
    customerId: string,
    input: Pick<
      StoredProfile,
      'tradeName' | 'governorate' | 'city' | 'applicationId' | 'termsVersion'
    > & { listId: string | null },
  ): void {
    const { listId, ...profile } = input;
    this.profiles.set(customerId, {
      ...profile,
      grantedAt: NOW(),
      revokedAt: null,
      level: null,
      levelChangedAt: null,
      tier: {
        tier: 'bronze',
        earnedTier: 'bronze',
        source: null,
        since: null,
        openGrant: null,
        grants: [],
      },
      thisMonthUsdUnits: 180 * USD,
      previousMonthUsdUnits: 95 * USD,
      watchCount: 0,
      branding: { showWhatsapp: false, whatsapp: null, logoFileId: null, welcomeText: null },
    });
    this.priceLists.assign(
      customerId,
      listId && listId !== ROOT_PRICE_LIST_IDS.wholesale ? listId : null,
    );
  }

  private move(
    application: AdminMerchantApplication,
    action: ApplicationAction,
    message: string | null,
  ): Answer {
    const next = applicationTransition(application.status, action);
    if (next === null) {
      return error(409, 'APPLICATION_STATE_INVALID', { status: application.status });
    }
    const now = NOW();
    application.status = next;
    if (message) application.adminMessage = message;
    if (action === 'request_info') application.infoRequestedAt = now;
    if (action !== 'request_info' && action !== 'resubmit') application.decidedAt = now;
    if (next === 'approved') {
      const list = this.priceLists.pricing(application.customer.id, 'merchant').effectiveList;
      application.approvedPriceList = { id: list.id, name: list.name };
    }
    application.events = [
      ...application.events,
      { event: EVENTS[action], message, createdAt: now },
    ];
    return { status: 200, json: this.detail(application) };
  }

  private detail(application: AdminMerchantApplication): AdminMerchantApplication {
    return {
      ...application,
      earlier: this.applications
        .filter((row) => row.customer.id === application.customer.id && row.id !== application.id)
        .map((row) => ({
          id: row.id,
          status: row.status,
          submittedAt: row.submittedAt,
          decidedAt: row.decidedAt,
        })),
    };
  }

  private row(application: AdminMerchantApplication): AdminMerchantApplicationRow {
    const person = this.customer(application.customer.id);
    return {
      id: application.id,
      status: application.status,
      tradeName: application.tradeName,
      governorate: application.governorate,
      activity: application.activity,
      monthlyVolume: application.monthlyVolume,
      submittedAt: application.submittedAt,
      customer: {
        id: application.customer.id,
        name: application.customer.name,
        email: application.customer.email,
        frozen: !!person?.frozenAt,
        sharedPhone: 1,
        newAccount: true,
      },
    };
  }

  /** S23 PX1: the three tier lists chained under wholesale, their levels at the starter values. */
  setupTiers(): void {
    let parent: string = ROOT_PRICE_LIST_IDS.wholesale;
    for (const tier of LEVEL_TIERS) {
      const list = this.priceLists.addList(TIER_LIST_NAMES[tier], parent);
      this.levels[tier] = {
        id: nextId(),
        monthlyThresholdUsdUnits: TIER_THRESHOLD_DEFAULTS[tier],
        priceListId: list.id,
      };
      parent = list.id;
    }
    this.recomputeAll();
  }

  /** S21 LV2: a merchant's net purchases this and last month; the earned tier follows (TR6). */
  setMonths(customerId: string, thisMonthUsdUnits: number, previousMonthUsdUnits: number): void {
    const profile = this.profiles.get(customerId);
    if (!profile) return;
    profile.thisMonthUsdUnits = thisMonthUsdUnits;
    profile.previousMonthUsdUnits = previousMonthUsdUnits;
    this.recompute(profile);
  }

  /** TS3: the deposit limits of a merchant's effective tier. */
  depositTier(
    customerId: string,
  ): { perDepositUsdUnits: number; dailyDepositUsdUnits: number } | null {
    const profile = this.profiles.get(customerId);
    if (!profile || !this.isMerchant(customerId)) return null;
    const settings = this.tierSettings[profile.tier.tier];
    return {
      perDepositUsdUnits: settings.perDepositUsdUnits,
      dailyDepositUsdUnits: settings.dailyDepositUsdUnits,
    };
  }

  private thresholds(): Partial<Record<LevelTier, number>> {
    return Object.fromEntries(
      LEVEL_TIERS.flatMap((tier) => {
        const level = this.levels[tier];
        return level ? [[tier, level.monthlyThresholdUsdUnits]] : [];
      }),
    );
  }

  /** TR3, TR6: the earned tier from the months; an open grant's live tier wins when higher. */
  private recompute(profile: StoredProfile): void {
    const earned = earnedTierFor(
      this.thresholds(),
      profile.previousMonthUsdUnits,
      profile.thisMonthUsdUnits,
    );
    const grant = profile.tier.openGrant;
    const granted =
      grant && this.levels[grant.tier] && tierRank(grant.tier) > tierRank(earned)
        ? grant.tier
        : null;
    const tier = granted ?? earned;
    const changed = tier !== profile.tier.tier;
    profile.tier = {
      ...profile.tier,
      tier,
      earnedTier: earned,
      source: granted ? 'granted' : tier === 'bronze' ? null : 'earned',
      since: changed ? NOW() : profile.tier.since,
    };
    const level = tier === 'bronze' ? undefined : this.levels[tier];
    profile.level =
      tier !== 'bronze' && level ? { id: level.id, nameAr: TIER_LIST_NAMES[tier] } : null;
    if (changed) profile.levelChangedAt = NOW();
  }

  private recomputeAll(): void {
    for (const profile of this.profiles.values()) {
      if (profile.revokedAt === null) this.recompute(profile);
    }
  }

  /** TS1, the levels' rules: thresholds in order, a custom list under the tier below's; null archives. */
  private setLevel(tier: MerchantTier, body: Body): Answer {
    if (tier === 'bronze') return error(404, 'NOT_FOUND');
    const parsed = tierLevelInputSchema.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED');
    const values = parsed.data.level;
    if (values === null) {
      delete this.levels[tier];
      // MG7: the tier's open grants end before the recomputation.
      for (const profile of this.profiles.values()) {
        if (profile.tier.openGrant?.tier === tier) this.closeGrant(profile, 'tier_archived');
      }
    } else {
      const others = LEVEL_TIERS.flatMap((other) => {
        const level = this.levels[other];
        return level && other !== tier ? [{ tier: other, ...level }] : [];
      });
      if (!tierThresholdsRise([...others, { tier, ...values }])) {
        return error(409, 'MERCHANT_TIER_ORDER_INVALID');
      }
      const list = this.priceLists.lists.find((row) => row.id === values.priceListId);
      const parent = expectedParentListId(tier, others, ROOT_PRICE_LIST_IDS.wholesale);
      const kept = values.priceListId === this.levels[tier]?.priceListId;
      if (list?.kind !== 'custom' || (!kept && list.parentListId !== parent)) {
        return error(409, 'MERCHANT_TIER_LIST_INVALID');
      }
      this.levels[tier] = { id: this.levels[tier]?.id ?? nextId(), ...values };
    }
    this.recomputeAll();
    return { status: 200, json: this.tierRows().find((row) => row.tier === tier) };
  }

  private saveTierSettings(tier: MerchantTier, body: Body): Answer {
    const parsed = tierSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      return error(
        400,
        'VALIDATION_FAILED',
        parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
    for (const field of ['perDepositUsdUnits', 'dailyDepositUsdUnits'] as const) {
      if (parsed.data[field] < MIN_DEPOSIT) {
        return error(400, 'VALIDATION_FAILED', [
          { path: [field], message: 'Below the deposit minimum' },
        ]);
      }
    }
    this.tierSettings[tier] = { ...parsed.data, updatedAt: NOW() };
    return { status: 200, json: this.tierRows().find((row) => row.tier === tier) };
  }

  /** AD3: the earned tiers at today's and at the proposed thresholds. */
  private preview(proposed: Record<LevelTier, number | null>) {
    const now = this.thresholds();
    const moves = [...this.profiles.entries()]
      .filter(([customerId]) => this.isMerchant(customerId))
      .map(([customerId, profile]) => ({
        customerId,
        tradeName: profile.tradeName,
        from: earnedTierFor(now, profile.previousMonthUsdUnits, profile.thisMonthUsdUnits),
        to: earnedTierFor(proposed, profile.previousMonthUsdUnits, profile.thisMonthUsdUnits),
      }));
    const rising = moves.filter((move) => tierRank(move.to) > tierRank(move.from));
    const falling = moves.filter((move) => tierRank(move.to) < tierRank(move.from));
    return {
      tiers: MERCHANT_TIERS.map((tier) => ({
        tier,
        now: moves.filter((move) => move.from === tier).length,
        proposed: moves.filter((move) => move.to === tier).length,
      })),
      rising,
      risingTotal: rising.length,
      falling,
      fallingTotal: falling.length,
    };
  }

  /** MG1: a live tier above the earned one, 1 to 90 days, one open grant at a time. */
  private grantTier(customerId: string, body: Body): Answer {
    const parsed = tierGrantInputSchema.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED');
    const endsAt = tierGrantEndsAt(parsed.data.endsOn, new Date());
    if (endsAt === null) {
      return error(400, 'VALIDATION_FAILED', [{ path: ['endsOn'], message: 'Out of range' }]);
    }
    const profile = this.profiles.get(customerId);
    if (!profile || !this.isMerchant(customerId)) return error(409, 'NOT_MERCHANT');
    if (!this.levels[parsed.data.tier]) return error(409, 'MERCHANT_TIER_UNAVAILABLE');
    if (tierRank(parsed.data.tier) <= tierRank(profile.tier.earnedTier)) {
      return error(409, 'MERCHANT_TIER_GRANT_NOT_HIGHER');
    }
    if (profile.tier.openGrant) return error(409, 'MERCHANT_TIER_GRANT_OPEN');
    const grant: TierGrant = {
      id: nextId(),
      tier: parsed.data.tier,
      startsAt: NOW(),
      endsAt: endsAt.toISOString(),
      reason: parsed.data.reason,
      endedAt: null,
      endReason: null,
    };
    profile.tier = { ...profile.tier, openGrant: grant, grants: [grant, ...profile.tier.grants] };
    this.recompute(profile);
    return { status: 201, json: grant };
  }

  /** MG3: ends the open grant now. */
  private endGrant(customerId: string, body: Body): Answer {
    if (!tierGrantEndInputSchema.safeParse(body).success) return error(400, 'VALIDATION_FAILED');
    const profile = this.profiles.get(customerId);
    if (!profile || !this.isMerchant(customerId)) return error(409, 'NOT_MERCHANT');
    if (!profile.tier.openGrant) return error(404, 'NOT_FOUND');
    const ended = this.closeGrant(profile, 'ended_by_admin');
    this.recompute(profile);
    return { status: 200, json: ended };
  }

  private closeGrant(
    profile: StoredProfile,
    reason: 'ended_by_admin' | 'tier_archived',
  ): TierGrant {
    const open = profile.tier.openGrant as TierGrant;
    const ended: TierGrant = { ...open, endedAt: NOW(), endReason: reason };
    profile.tier = {
      ...profile.tier,
      openGrant: null,
      grants: profile.tier.grants.map((grant) => (grant.id === open.id ? ended : grant)),
    };
    return ended;
  }

  /** AD2: the four tiers, Bronze on wholesale, each live level on its list. */
  private tierRows(): MerchantTierView[] {
    const listRef = (id: string) => {
      const list = this.priceLists.lists.find((row) => row.id === id);
      return {
        id,
        name: list?.name ?? '',
        parentListId: list?.parentListId ?? null,
        archived: !!list?.archivedAt,
      };
    };
    const live = LEVEL_TIERS.flatMap((tier) => {
      const level = this.levels[tier];
      return level ? [{ tier, priceListId: level.priceListId }] : [];
    });
    const held = [...this.profiles.entries()]
      .filter(([customerId]) => this.isMerchant(customerId))
      .map(([, profile]) => profile.tier);
    return MERCHANT_TIERS.map((tier): MerchantTierView => {
      const level = tier === 'bronze' ? undefined : this.levels[tier];
      return {
        tier,
        level:
          tier !== 'bronze' && level
            ? {
                id: level.id,
                monthlyThresholdUsdUnits: level.monthlyThresholdUsdUnits,
                priceList: listRef(level.priceListId),
                expectedParentListId: expectedParentListId(
                  tier,
                  live,
                  ROOT_PRICE_LIST_IDS.wholesale,
                ),
              }
            : null,
        priceList:
          tier === 'bronze'
            ? listRef(ROOT_PRICE_LIST_IDS.wholesale)
            : level
              ? listRef(level.priceListId)
              : null,
        settings: this.tierSettings[tier],
        merchants: {
          earned: held.filter((row) => row.tier === tier && row.source !== 'granted').length,
          granted: held.filter((row) => row.tier === tier && row.source === 'granted').length,
        },
      };
    });
  }

  private merchantRow(customerId: string, profile: StoredProfile): AdminMerchantRow {
    const person = this.customer(customerId);
    const pricing = this.priceLists.pricing(customerId, 'merchant');
    return {
      customerId,
      name: person?.name ?? '',
      email: person?.email ?? '',
      tradeName: profile.tradeName,
      governorate: profile.governorate,
      city: profile.city,
      priceList: { id: pricing.effectiveList.id, name: pricing.effectiveList.name },
      priceKind: priceKindOf(pricing.effectiveList.kind),
      level: profile.level,
      tier: profile.tier.tier,
      tierGranted: profile.tier.source === 'granted',
      termsAccepted: profile.termsVersion !== null,
      frozen: !!person?.frozenAt,
      grantedAt: profile.grantedAt,
      sales30dUsdUnits: 245 * USD,
    };
  }
}
