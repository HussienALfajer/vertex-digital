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
  type MerchantSettings,
  merchantLimitsBelowMinimum,
  merchantMessageSchema,
  merchantSettingsInputSchema,
  priceKindOf,
  ROOT_PRICE_LIST_IDS,
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
    minDepositUsdUnits: MIN_DEPOSIT,
    updatedAt: '2026-10-20T09:00:00.000Z',
  };

  constructor(
    private readonly reauthenticationRequired: () => boolean,
    private readonly customer: (id: string) => MockMerchantCustomer | null,
    private readonly priceLists: PriceListsMock,
    private readonly profile: (customerId: string) => AdminCustomer | null,
  ) {}

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
      const rows = [...this.profiles.entries()]
        .filter(([customerId]) => this.isMerchant(customerId))
        .map(([customerId, profile]) => this.merchantRow(customerId, profile))
        .filter((row) => !listId || row.priceList.id === listId)
        .filter((row) => !q || row.tradeName.includes(q) || row.name.includes(q));
      return { status: 200, json: { items: rows, nextCursor: null } };
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
    input: Omit<StoredProfile, 'grantedAt' | 'revokedAt'> & { listId: string | null },
  ): void {
    const { listId, ...profile } = input;
    this.profiles.set(customerId, { ...profile, grantedAt: NOW(), revokedAt: null });
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
      termsAccepted: profile.termsVersion !== null,
      frozen: !!person?.frozenAt,
      grantedAt: profile.grantedAt,
      sales30dUsdUnits: 245 * USD,
    };
  }
}
