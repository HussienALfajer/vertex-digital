import {
  type AdminCustomer,
  type AdminMerchantApplication,
  type AdminMerchantApplicationRow,
  type AdminMerchantRow,
  type ApplicationAction,
  applicationTransition,
  type Governorate,
  grantMerchantSchema,
  MERCHANT_SETTINGS_DEFAULTS,
  type MerchantApplicationEventKind,
  type MerchantLevel,
  type MerchantSettings,
  merchantLevelInputSchema,
  merchantLimitsBelowMinimum,
  merchantMessageSchema,
  merchantSettingsInputSchema,
  priceKindOf,
  ROOT_PRICE_LIST_IDS,
  removeMerchantLogoSchema,
  revokeMerchantSchema,
} from '@vertex-digital/contracts';
import { type Answer, nextId } from './catalog-mock';
import type { PriceListsMock } from './price-lists-mock';

/*
 * Merchants of S20 PR 3 as the panel sees them: applications moved on the contracts'
 * `applicationTransition` (MA4), approvals and direct grants that make the account a merchant on
 * its list (MA5, MA6), revocations (MA7), the merchants list and the settings with the deposit
 * minimum check. `seedApplication` adds one for a test.
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
  /** S21 LV4: the level, set by a test (`setLevel`). */
  level: { id: string; nameAr: string } | null;
  levelChangedAt: string | null;
  thisMonthUsdUnits: number;
  previousMonthUsdUnits: number;
  watchCount: number;
  /** S21 BR3: the receipt branding; a test sets a logo with `setBranding`. */
  branding: { showWhatsapp: boolean; whatsapp: string | null; logoFileId: string | null };
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
  /** S21 LV1: the levels, live and archived. */
  levels: Omit<MerchantLevel, 'merchantCount'>[] = [];
  settings: MerchantSettings = {
    ...MERCHANT_SETTINGS_DEFAULTS,
    minDepositUsdUnits: MIN_DEPOSIT,
    updatedAt: '2026-10-20T09:00:00.000Z',
  };

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
      const levelId = url.searchParams.get('levelId');
      const rows = [...this.profiles.entries()]
        .filter(([customerId]) => this.isMerchant(customerId))
        .map(([customerId, profile]) => this.merchantRow(customerId, profile))
        .filter((row) => !listId || row.priceList.id === listId)
        .filter(
          (row) =>
            !levelId || (levelId === 'none' ? row.level === null : row.level?.id === levelId),
        )
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
    if (key === 'GET /api/admin/merchant-levels') {
      return { status: 200, json: { items: this.levelRows() } };
    }
    const level = path.match(/^\/api\/admin\/merchant-levels(?:\/([^/]+))?(\/archive)?$/);
    if (level && (method === 'POST' || method === 'PATCH')) {
      const refused = sensitive();
      if (refused) return refused;
      return this.changeLevel(method, level[1] ?? null, Boolean(level[2]), body);
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
      const below = merchantLimitsBelowMinimum(parsed.data, MIN_DEPOSIT);
      if (below.length > 0) {
        return error(
          400,
          'VALIDATION_FAILED',
          below.map((field) => ({ path: [field], message: 'Below the deposit minimum' })),
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
      thisMonthUsdUnits: 180 * USD,
      previousMonthUsdUnits: 95 * USD,
      watchCount: 0,
      branding: { showWhatsapp: false, whatsapp: null, logoFileId: null },
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

  /** A test's level for a merchant (the worker's recomputation, LV4). */
  setLevel(customerId: string, levelId: string | null): void {
    const profile = this.profiles.get(customerId);
    if (!profile) return;
    const found = this.levels.find((row) => row.id === levelId);
    profile.level = found ? { id: found.id, nameAr: found.nameAr } : null;
    profile.levelChangedAt = NOW();
  }

  private levelRows(): MerchantLevel[] {
    return [...this.levels]
      .sort(
        (a, b) =>
          Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
          a.monthlyThresholdUsdUnits - b.monthlyThresholdUsdUnits,
      )
      .map((row) => ({
        ...row,
        merchantCount: [...this.profiles.values()].filter(
          (profile) => profile.revokedAt === null && profile.level?.id === row.id,
        ).length,
      }));
  }

  /** LV1, LV6: create, edit or archive under the contracts' schema and the live uniqueness. */
  private changeLevel(method: string, id: string | null, archive: boolean, body: Body): Answer {
    const current = id ? this.levels.find((row) => row.id === id && row.archivedAt === null) : null;
    if (id && !current) return error(404, 'NOT_FOUND');
    if (archive && current) {
      current.archivedAt = NOW();
      for (const profile of this.profiles.values()) {
        if (profile.level?.id === current.id) profile.level = null;
      }
      return { status: 200, json: { ...current, merchantCount: 0 } };
    }
    const parsed = merchantLevelInputSchema.safeParse(body);
    if (!parsed.success) return error(400, 'VALIDATION_FAILED');
    const list = this.priceLists.lists.find((row) => row.id === parsed.data.priceListId);
    if (!list || (list.kind !== 'wholesale' && list.kind !== 'custom')) {
      return error(400, 'VALIDATION_FAILED');
    }
    const live = this.levels.filter((row) => row.archivedAt === null && row.id !== id);
    if (!id && live.length >= 10) return error(409, 'MERCHANT_LEVELS_LIMIT_REACHED');
    if (live.some((row) => row.nameAr === parsed.data.nameAr)) {
      return error(409, 'MERCHANT_LEVEL_NAME_TAKEN');
    }
    if (live.some((row) => row.monthlyThresholdUsdUnits === parsed.data.monthlyThresholdUsdUnits)) {
      return error(409, 'MERCHANT_LEVEL_THRESHOLD_TAKEN');
    }
    const values = {
      nameAr: parsed.data.nameAr,
      monthlyThresholdUsdUnits: parsed.data.monthlyThresholdUsdUnits,
      priceList: { id: list.id, name: list.name, priceKind: priceKindOf(list.kind) },
    };
    if (current) {
      Object.assign(current, values);
      return { status: 200, json: this.levelRows().find((row) => row.id === current.id) };
    }
    const created = { id: nextId(), ...values, createdAt: NOW(), archivedAt: null };
    this.levels.push(created);
    return { status: method === 'POST' ? 201 : 200, json: { ...created, merchantCount: 0 } };
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
      termsAccepted: profile.termsVersion !== null,
      frozen: !!person?.frozenAt,
      grantedAt: profile.grantedAt,
      sales30dUsdUnits: 245 * USD,
    };
  }
}
