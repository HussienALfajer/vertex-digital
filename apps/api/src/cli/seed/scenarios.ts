import { spawnSync } from 'node:child_process';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { ROOT_PRICE_LIST_IDS, USD_CENT } from '@vertex-digital/contracts';
import type { Database } from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import type { RequestMeta } from '../../core/http/request-meta.js';
import type { AdminIdentity } from '../../modules/admin/index.js';
import { createDevCustomer, createDevSession } from '../../modules/auth/index.js';
import {
  ContentFaqService,
  ContentHomeService,
  ContentPagesService,
} from '../../modules/content/index.js';
import { CustomersService } from '../../modules/customers/index.js';
import {
  DepositReviewService,
  DepositSettingsService,
  DepositsService,
  UsdtDepositsService,
} from '../../modules/deposits/index.js';
import { PushService } from '../../modules/notifications/index.js';
import {
  AdminPurchasesService,
  OrderActionsService,
  OrderDecisionsService,
  OrdersService,
  ShareLinksService,
} from '../../modules/orders/index.js';
import { PricingService } from '../../modules/pricing/index.js';
import { RatesService } from '../../modules/rates/index.js';
import { ReconciliationService } from '../../modules/reconciliation/index.js';
import { RoutesService } from '../../modules/suppliers/index.js';
import { SupportAdminService, SupportService } from '../../modules/support/index.js';
import { TreasuryService } from '../../modules/treasury/index.js';
import { WalletAdjustmentsService, WalletService } from '../../modules/wallet/index.js';
import { bannerImage, noteImage, qrImage, receiptImage } from './images.js';

/*
 * The scenarios of `db:seed-local`: one realistic store day for the local panel and store. Every
 * write goes through the API's services (the same rules, ledger journals, audit entries and
 * notifications as a real request), the customers' as the `cli` channel without the request
 * limits; the worker fulfils the orders against the fake supplier while this runs. A step that a
 * rule refuses is reported and skipped, so one refusal never hides the rest.
 */

const usd = (dollars: number) => Math.round(dollars * 100) * USD_CENT;

const ADMIN_META: RequestMeta = { ipAddress: '127.0.0.1', userAgent: 'db:seed-local' };

/** The customers (personas) of the store; the first ones buy the most. */
const PEOPLE = [
  { key: 'ahmad', name: 'أحمد الحلبي', email: 'ahmad.halabi@example.com', phone: '+963933100201' },
  { key: 'sara', name: 'سارة الخطيب', email: 'sara.khatib@example.com', phone: '+963944100202' },
  {
    key: 'mohammad',
    name: 'محمد العلي',
    email: 'mohammad.ali@example.com',
    phone: '+963955100203',
  },
  { key: 'layla', name: 'ليلى حداد', email: 'layla.haddad@example.com', phone: '+963966100204' },
  { key: 'omar', name: 'عمر الشامي', email: 'omar.shami@example.com', phone: '+963988100205' },
  { key: 'reem', name: 'ريم النجار', email: 'reem.najjar@example.com', phone: '+963999100206' },
  { key: 'hasan', name: 'حسن الأحمد', email: 'hasan.ahmad@example.com', phone: '+963933100207' },
  {
    key: 'zainab',
    name: 'زينب درويش',
    email: 'zainab.darwish@example.com',
    phone: '+963944100208',
  },
  // A shared phone with Khaled (fraud signal, S12).
  { key: 'yousef', name: 'يوسف قاسم', email: 'yousef.qasem@example.com', phone: '+963955100209' },
  { key: 'khaled', name: 'خالد المصري', email: 'khaled.masri@example.com', phone: '+963955100209' },
  { key: 'nour', name: 'نور السيد', email: 'nour.sayed@example.com', phone: '+963966100211' },
  { key: 'tarek', name: 'طارق عيسى', email: 'tarek.issa@example.com', phone: '+963988100212' },
  {
    key: 'rami',
    name: 'رامي يونس',
    email: 'rami.younes@example.com',
    phone: '+963999100213',
    unverified: true,
  },
  // Test customers (S01 T1–T4).
  {
    key: 'tc1',
    name: 'عميل اختبار مشتري',
    email: 'tc1.buyer@example.com',
    phone: '+963933100301',
    test: true,
  },
  {
    key: 'tc2',
    name: 'عميل اختبار مستهدف',
    email: 'tc2.target@example.com',
    phone: '+963944100302',
    test: true,
  },
  {
    key: 'tc3',
    name: 'عميل اختبار مستلم',
    email: 'tc3.receiver@example.com',
    phone: '+963955100303',
    test: true,
  },
] as const;

type PersonKey = (typeof PEOPLE)[number]['key'];

const DEVICES = [
  'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36',
];

interface Product {
  id: string;
  name: string;
  kind: 'direct' | 'code';
  priceUnits: number;
  gameName: string;
  mirrorOfferId: string | null;
  manualRouteId: string | null;
  fields: {
    key: string;
    type: string;
    minLength: number | null;
    maxLength: number | null;
    options: { value: string }[] | null;
  }[];
}

export interface SeedReport {
  steps: number;
  skipped: string[];
  customers: { email: string; name: string; test: boolean }[];
}

export class Scenarios {
  private readonly report: SeedReport = { steps: 0, skipped: [], customers: [] };
  private readonly people = new Map<PersonKey, string>();
  private readonly admin: { adminId: string; meta: RequestMeta };
  private products: Product[] = [];
  private counter = 0;

  constructor(
    private readonly app: INestApplicationContext,
    private readonly db: Database,
    private readonly input: {
      adminId: string;
      adminName: string;
      adminEmail: string;
      customerPassword: string;
      fakeState: {
        setScripts(scripts: Record<string, string>): Promise<void>;
        setCost(offerId: string, units: number): Promise<void>;
      };
      log: (line: string) => void;
    },
  ) {
    this.admin = { adminId: input.adminId, meta: ADMIN_META };
  }

  private get<T>(type: new (...args: never[]) => T): T {
    return this.app.get(type, { strict: false });
  }

  /** Runs one step; a refusal is reported and the seed goes on. */
  private async step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await run();
      this.report.steps += 1;
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const details = (error as { getResponse?: () => unknown }).getResponse?.();
      const reason = code ?? (error instanceof Error ? error.message : String(error));
      this.report.skipped.push(
        `${name}: ${reason}${details ? ` ${JSON.stringify(details).slice(0, 300)}` : ''}`,
      );
      this.input.log(`  skipped ${name}: ${reason}`);
      return undefined;
    }
  }

  private person(key: PersonKey): string {
    const id = this.people.get(key);
    if (!id) throw new Error(`No seeded customer ${key}`);
    return id;
  }

  private meta(key: PersonKey): RequestMeta {
    const index = PEOPLE.findIndex((person) => person.key === key);
    return {
      ipAddress: `10.20.0.${index + 10}`,
      userAgent: DEVICES[index % DEVICES.length] as string,
    };
  }

  private reference(prefix: string): string {
    this.counter += 1;
    return `${prefix}${Date.now().toString(36).toUpperCase()}${this.counter}`;
  }

  async run(): Promise<SeedReport> {
    const log = this.input.log;
    log('Store settings: switches, exchange rate, deposit settings, support channel');
    await this.settings();
    log('Content: pages, FAQ, banners, announcements');
    await this.content();
    log('Customers and their devices');
    await this.customers();
    log('Wallet adjustments');
    await this.adjustments();
    log('Sham Cash and USDT deposits');
    await this.deposits();
    log('Orders through the fake supplier');
    await this.loadProducts();
    await this.orders();
    log('Admin decisions on orders');
    await this.orderDecisions();
    log('Customers: states, notes, limits, push devices');
    await this.customerAdmin();
    log('Support tickets');
    await this.support();
    log('Treasury and reconciliation');
    await this.treasury();
    log('Pricing: a margin rule and a price review');
    await this.pricing();
    return this.report;
  }

  // Settings ----------------------------------------------------------------------------------

  private async settings(): Promise<void> {
    // WDGZone was paused by `seed-local.ts` before its routes were loaded.
    const rates = this.get(RatesService);
    await this.step('exchange rate 13,800', () =>
      rates.change(
        this.admin.adminId,
        { sypPerUsd: '13800', displayStepSypUnits: 500 },
        ADMIN_META,
      ),
    );
    await this.step('exchange rate 14,100', () =>
      rates.change(
        this.admin.adminId,
        { sypPerUsd: '14100', displayStepSypUnits: 500 },
        ADMIN_META,
      ),
    );
    const deposits = this.get(DepositSettingsService);
    await this.step('deposit settings', async () => {
      const syp = await deposits.uploadQr(await qrImage('Sham Cash SYP 0991 234 567'));
      const usdQr = await deposits.uploadQr(await qrImage('Sham Cash USD 0991 234 567'));
      return deposits.save(
        this.admin.adminId,
        {
          shamCashAccountName: 'Vertex Digital',
          shamCashAccountNumber: '0991234567',
          sypEnabled: true,
          usdEnabled: true,
          sypQrFileId: syp.fileId,
          usdQrFileId: usdQr.fileId,
          minDepositUsdUnits: usd(2),
          newAccountPerDepositUsdUnits: usd(50),
          newAccountDailyUsdUnits: usd(100),
          establishedPerDepositUsdUnits: usd(300),
          establishedDailyUsdUnits: usd(1000),
          reviewHoursStart: '00:00',
          reviewHoursEnd: '23:59',
          reviewTargetMinutes: 15,
          flagNewAccountUsdUnits: usd(25),
          flagVelocityCount: 3,
          // USDT needs the receiving address in the server's environment (S04).
          usdtTrc20Enabled: deposits.usdtAddress('usdt_trc20') !== null,
          usdtBep20Enabled: deposits.usdtAddress('usdt_bep20') !== null,
          usdtMinDepositUsdUnits: usd(5),
          telegramApprovalMaxUsdUnits: usd(100),
        },
        ADMIN_META,
      );
    });
    await this.step('support channel', () =>
      this.get(SupportAdminService).updateSettings(
        this.admin.adminId,
        { telegramUrl: 'https://t.me/vertexdigital_support' },
        ADMIN_META,
      ),
    );
  }

  // Content -----------------------------------------------------------------------------------

  private async content(): Promise<void> {
    const pages = this.get(ContentPagesService);
    const texts: Record<'terms' | 'privacy' | 'refund' | 'about', { title: string; body: string }> =
      {
        terms: {
          title: 'شروط الاستخدام',
          body: '## القبول\nباستخدامك متجر Vertex Digital فأنت توافق على هذه الشروط.\n\n## الحساب\n- حساب واحد لكل شخص.\n- أنت مسؤول عن سرية كلمة المرور.\n\n## الشحن والمحفظة\nرصيد المحفظة بالدولار الأمريكي ويُستخدم للشراء من المتجر فقط.\n\n## التسليم\nتُنفَّذ معظم الطلبات خلال ثوانٍ. تأكد من صحة معرّف اللاعب قبل الشراء.',
        },
        privacy: {
          title: 'سياسة الخصوصية',
          body: '## ما نجمعه\nالاسم والبريد ورقم الهاتف وسجل الطلبات والإيداعات.\n\n## لماذا\nلتنفيذ طلباتك وحماية حسابك ومنع الاحتيال.\n\n## مع من نشاركه\nنرسل إلى المورّد معرّف اللاعب فقط عند تنفيذ الطلب.',
        },
        refund: {
          title: 'سياسة الاسترجاع',
          body: '## متى يُسترجع المبلغ\nإذا تعذّر تنفيذ الطلب يعود المبلغ إلى محفظتك تلقائيًا.\n\n## ما لا يُسترجع\nالطلبات المسلّمة إلى معرّف أدخلته بنفسك، والأكواد بعد كشفها.',
        },
        about: {
          title: 'من نحن',
          body: 'Vertex Digital متجر سوري لشحن الألعاب والتطبيقات وبطاقات الهدايا، بمحفظة بالدولار وتسليم آلي خلال ثوانٍ.',
        },
      };
    for (const [page, text] of Object.entries(texts) as [
      keyof typeof texts,
      (typeof texts)['terms'],
    ][]) {
      await this.step(`page ${page}`, async () => {
        const draft = await pages.draft(page);
        const saved = await pages.saveDraft(this.admin, page, {
          ...text,
          revision: draft.revision,
        });
        return pages.publish(this.admin, page, saved.revision);
      });
    }
    // The terms keep a draft ahead of the published version (S14).
    await this.step('terms draft ahead', async () => {
      const draft = await pages.draft('terms');
      return pages.saveDraft(this.admin, 'terms', {
        title: 'شروط الاستخدام',
        body: `${texts.terms.body}\n\n## تعديل قيد المراجعة\nمسودة لم تُنشر بعد.`,
        revision: draft.revision,
      });
    });

    const faq = this.get(ContentFaqService);
    await this.step('FAQ', async () => {
      const sections = [
        {
          title: 'الشحن والمحفظة',
          items: [
            ['كيف أشحن محفظتي؟', 'من صفحة المحفظة اختر شام كاش أو USDT واتبع الخطوات.'],
            [
              'كم يستغرق تأكيد الإيداع؟',
              'إيداعات شام كاش تُراجع عادةً خلال 15 دقيقة ضمن ساعات العمل، وUSDT تلقائيًا بعد التأكيدات.',
            ],
          ],
        },
        {
          title: 'الطلبات',
          items: [
            ['متى يصل الشحن؟', 'معظم الطلبات تُسلَّم خلال ثوانٍ، وبعضها خلال دقائق.'],
            ['أدخلت معرّفًا خاطئًا، ماذا أفعل؟', 'افتح تذكرة دعم فورًا مع رقم الطلب.'],
          ],
        },
        {
          title: 'الحساب والأمان',
          items: [['هل يمكنني تغيير بريدي؟', 'نعم من صفحة الحساب بعد تأكيد البريد الجديد.']],
        },
      ];
      for (const section of sections) {
        const created = await faq.createSection(this.admin, { title: section.title });
        for (const [question, answer] of section.items) {
          await faq.createItem(this.admin, {
            sectionId: created.id,
            question: question as string,
            answer: answer as string,
          });
        }
      }
      const copy = await faq.workingCopy(false);
      return faq.publish(this.admin, copy.revision);
    });

    const home = this.get(ContentHomeService);
    const banners = [
      {
        title: 'PUBG UC',
        from: '#0F3D3E',
        to: '#C9A227',
        alt: 'شحن شدات ببجي فوري',
        link: '/games/pubg-mobile',
        state: 'live',
      },
      {
        title: 'Free Fire',
        from: '#5A1E1E',
        to: '#E07A2E',
        alt: 'جواهر فري فاير بأفضل سعر',
        link: '/games/free-fire',
        state: 'live',
      },
      {
        title: 'Gift Cards',
        from: '#1E2A5A',
        to: '#3E8EDE',
        alt: 'بطاقات iTunes وGoogle Play',
        link: '/games/itunes',
        state: 'scheduled',
      },
      {
        title: 'Ramadan',
        from: '#2E2E2E',
        to: '#7A7A7A',
        alt: 'عرض منتهي',
        link: null,
        state: 'ended',
      },
      {
        title: 'Draft',
        from: '#3A2E5A',
        to: '#8E6EDE',
        alt: 'لافتة غير مفعّلة',
        link: null,
        state: 'disabled',
      },
      {
        title: 'Old',
        from: '#444444',
        to: '#999999',
        alt: 'لافتة مؤرشفة',
        link: null,
        state: 'archived',
      },
    ];
    const now = Date.now();
    for (const banner of banners) {
      await this.step(`banner ${banner.state}`, async () => {
        const image = await home.uploadBannerImage(await bannerImage(banner));
        const window =
          banner.state === 'scheduled'
            ? {
                startsAt: new Date(now + 3 * 86_400_000).toISOString(),
                endsAt: new Date(now + 10 * 86_400_000).toISOString(),
              }
            : banner.state === 'ended'
              ? {
                  // Times must be ahead when set: it ends two minutes after the seed.
                  startsAt: new Date(now + 60_000).toISOString(),
                  endsAt: new Date(now + 120_000).toISOString(),
                }
              : {};
        const created = await home.createBanner(this.admin, {
          imageFileId: image.fileId,
          altText: banner.alt,
          linkPath: banner.link,
          ...window,
        });
        if (banner.state !== 'disabled' && banner.state !== 'archived') {
          await home.enableBanner(this.admin, created.id);
        }
        if (banner.state === 'archived') await home.archiveBanner(this.admin, created.id);
        return created;
      });
    }
    await this.step('announcements', async () => {
      const live = await home.createAnnouncement(this.admin, {
        text: 'خصم 5% على شدات ببجي حتى نهاية الأسبوع',
        linkPath: '/games/pubg-mobile',
        tone: 'info',
      });
      await home.enableAnnouncement(this.admin, live.id);
      await home.createAnnouncement(this.admin, {
        text: 'صيانة مجدولة لإيداعات USDT ليلة الجمعة',
        tone: 'warning',
        startsAt: new Date(now + 2 * 86_400_000).toISOString(),
        endsAt: new Date(now + 3 * 86_400_000).toISOString(),
      });
      return live;
    });
  }

  // Customers ---------------------------------------------------------------------------------

  private async customers(): Promise<void> {
    const versions = (
      await this.db.execute<{ page: string; id: string }>(
        sql`SELECT DISTINCT ON (page) page, id FROM content_page_versions WHERE page IN ('terms', 'privacy') ORDER BY page, version DESC`,
      )
    ).rows;
    const termsVersionId = versions.find((row) => row.page === 'terms')?.id ?? null;
    const privacyVersionId = versions.find((row) => row.page === 'privacy')?.id ?? null;
    for (const [index, person] of PEOPLE.entries()) {
      const meta = this.meta(person.key);
      const { id, created } = await createDevCustomer(
        this.db,
        {
          name: person.name,
          email: person.email,
          phone: person.phone,
          emailVerified: !('unverified' in person),
          isTest: 'test' in person,
          // Joined over the last weeks, the first ones earliest.
          joinedAt: new Date(Date.now() - (PEOPLE.length - index) * 2.5 * 86_400_000),
          termsVersionId,
          privacyVersionId,
          // Khaled's last sign-in shares an address with another customer (S12).
          signIns: [0, 1, 2].map((day) => ({
            ipAddress:
              day === 2 && person.key === 'khaled' ? '10.20.0.18' : (meta.ipAddress as string),
            userAgent: DEVICES[(index + day) % DEVICES.length] as string,
          })),
        },
        this.input.customerPassword,
      );
      this.people.set(person.key, id);
      if (created) {
        this.report.customers.push({
          email: person.email,
          name: person.name,
          test: 'test' in person,
        });
      }
    }
  }

  // Wallet ------------------------------------------------------------------------------------

  private async adjust(key: PersonKey, input: Parameters<WalletAdjustmentsService['create']>[3]) {
    return this.step(`adjustment ${input.category} for ${key}`, () =>
      this.get(WalletAdjustmentsService).create(
        this.admin.adminId,
        this.person(key),
        randomUUID(),
        input.amountUnits > usd(100)
          ? { ...input, amountConfirmationUnits: input.amountUnits }
          : input,
        ADMIN_META,
      ),
    );
  }

  private async adjustments(): Promise<void> {
    const funded: [PersonKey, number][] = [
      ['ahmad', 250],
      ['sara', 120],
      ['mohammad', 90],
      ['layla', 4],
      ['omar', 80],
      ['reem', 60],
      ['hasan', 75],
      ['zainab', 45],
      ['yousef', 40],
      ['khaled', 35],
      ['tarek', 30],
      ['nour', 20],
    ];
    for (const [key, dollars] of funded) {
      await this.adjust(key, {
        direction: 'credit',
        amountUnits: usd(dollars),
        category: 'manual_deposit',
        reason: 'إيداع نقدي في المكتب',
        customerNote: 'تم شحن محفظتك نقدًا',
        depositMethod: 'sham_cash',
        externalReference: this.reference('CASH'),
      });
    }
    for (const key of ['tc1', 'tc2', 'tc3'] as const) {
      await this.adjust(key, {
        direction: 'credit',
        amountUnits: usd(100),
        category: 'test_funds',
        reason: 'رصيد اختبار للنظام',
      });
    }
    await this.adjust('omar', {
      direction: 'credit',
      amountUnits: usd(3),
      category: 'compensation',
      reason: 'تعويض عن تأخير طلب سابق',
      customerNote: 'نعتذر عن التأخير',
    });
    await this.adjust('reem', {
      direction: 'debit',
      amountUnits: usd(5),
      category: 'correction',
      reason: 'تصحيح إيداع مكرر',
    });
    await this.adjust('hasan', {
      direction: 'debit',
      amountUnits: usd(10),
      category: 'cash_refund',
      reason: 'استرداد نقدي بطلب العميل',
    });
    const reversed = await this.adjust('zainab', {
      direction: 'credit',
      amountUnits: usd(15),
      category: 'compensation',
      reason: 'تعويض أُضيف بالخطأ',
    });
    if (reversed) {
      await this.step('reverse adjustment', () =>
        this.get(WalletAdjustmentsService).reverse(
          this.admin.adminId,
          reversed.adjustment.id,
          randomUUID(),
          { reason: 'التعويض أُضيف لعميل آخر بالخطأ' },
          ADMIN_META,
        ),
      );
    }
  }

  // Deposits ----------------------------------------------------------------------------------

  private async shamCash(
    key: PersonKey,
    currency: 'USD' | 'SYP',
    amountUnits: number,
    then: 'approve' | 'reject' | 'receipt' | 'submitted' | 'pending' | 'cancel',
  ): Promise<string | undefined> {
    const deposits = this.get(DepositsService);
    const review = this.get(DepositReviewService);
    const customerId = this.person(key);
    const meta = this.meta(key);
    return this.step(`Sham Cash ${currency} ${then} for ${key}`, async () => {
      const { deposit } = await deposits.create(
        customerId,
        randomUUID(),
        { currency, amountUnits },
        meta,
      );
      if (then === 'pending') return deposit.id;
      if (then === 'cancel') {
        await deposits.cancel(customerId, deposit.id, meta);
        return deposit.id;
      }
      const rate = currency === 'SYP' ? await this.get(RatesService).current() : null;
      const reference = this.reference('SC');
      const amount =
        currency === 'USD' ? `$${amountUnits / (100 * USD_CENT)}` : `${amountUnits / 100} SYP`;
      const submitted = await deposits.submitReceipt(
        customerId,
        deposit.id,
        await receiptImage({ amount, reference, tint: '#1FA67A' }),
        rate?.id,
        meta,
      );
      if (then === 'submitted') return submitted.id;
      if (then === 'approve') {
        const admin = await review.deposit(deposit.id);
        await review.approve(
          this.identity(),
          deposit.id,
          randomUUID(),
          {
            transactionNumber: reference,
            receivedCurrency: currency,
            receivedAmountUnits: amountUnits,
            referenceCheck: 'matches',
            acknowledgedFlags: admin.flags.map((flag) => flag.code),
          },
          ADMIN_META,
        );
      } else if (then === 'reject') {
        await review.reject(
          this.admin.adminId,
          deposit.id,
          randomUUID(),
          {
            reason: 'not_received',
            customerNote: 'لم يصل المبلغ إلى حسابنا، تأكد من رقم الحساب',
            internalNote: 'لا توجد حوالة بهذا الرقم في كشف شام كاش',
          },
          ADMIN_META,
        );
      } else {
        await review.requestReceipt(
          this.admin.adminId,
          deposit.id,
          {
            customerNote: 'الصورة غير واضحة، أرسل لقطة كاملة للإيصال',
            internalNote: 'رقم العملية غير ظاهر في الصورة',
          },
          ADMIN_META,
        );
      }
      return deposit.id;
    });
  }

  private identity(): AdminIdentity {
    return {
      id: this.input.adminId,
      name: this.input.adminName,
      email: this.input.adminEmail,
      twoFactorEnabled: true,
      mustChangePassword: false,
      archived: false,
      sessionId: 'db-seed-local',
      reauthenticatedAt: new Date(),
    };
  }

  private async deposits(): Promise<void> {
    await this.shamCash('sara', 'USD', usd(40), 'approve');
    await this.shamCash('sara', 'SYP', 282_000 * 100, 'approve');
    await this.shamCash('nour', 'USD', usd(30), 'approve');
    await this.shamCash('tarek', 'USD', usd(20), 'reject');
    await this.shamCash('reem', 'USD', usd(45), 'receipt');
    await this.shamCash('hasan', 'SYP', 423_000 * 100, 'submitted');
    await this.shamCash('omar', 'USD', usd(48), 'submitted');
    await this.shamCash('zainab', 'USD', usd(10), 'cancel');
    await this.shamCash('zainab', 'USD', usd(12), 'pending');
    // A new account sending a large amount in a row: flagged (FL3, FL4).
    await this.shamCash('nour', 'USD', usd(45), 'submitted');

    const usdt = this.get(UsdtDepositsService);
    const credited = await this.step('USDT TRC20 awaiting transfer for mohammad', () =>
      usdt.create(
        this.person('mohammad'),
        randomUUID(),
        { method: 'usdt_trc20', amountUnits: usd(25) },
        this.meta('mohammad'),
      ),
    );
    if (credited?.deposit.usdt) {
      const txid = randomBytes(32).toString('hex');
      await this.step('USDT fake transfer (credited by the worker)', async () => {
        fakeTransfer([
          '--method',
          'usdt_trc20',
          '--amount',
          credited.deposit.usdt?.payAmount as string,
          '--txid',
          txid,
        ]);
        return usdt.submitTxid(
          this.person('mohammad'),
          credited.deposit.id,
          { txid },
          this.meta('mohammad'),
        );
      });
    }
    const searching = await this.step('USDT BEP20 searching for ahmad', () =>
      usdt.create(
        this.person('ahmad'),
        randomUUID(),
        { method: 'usdt_bep20', amountUnits: usd(30) },
        this.meta('ahmad'),
      ),
    );
    if (searching) {
      await this.step('USDT TXID not on chain', () =>
        usdt.submitTxid(
          this.person('ahmad'),
          searching.deposit.id,
          { txid: randomBytes(32).toString('hex') },
          this.meta('ahmad'),
        ),
      );
    }
    await this.step('USDT TRC20 awaiting for yousef', () =>
      usdt.create(
        this.person('yousef'),
        randomUUID(),
        { method: 'usdt_trc20', amountUnits: usd(15) },
        this.meta('yousef'),
      ),
    );
  }

  // Orders ------------------------------------------------------------------------------------

  private async loadProducts(): Promise<void> {
    const rows = (
      await this.db.execute<{
        id: string;
        name: string;
        kind: 'direct' | 'code';
        price: string;
        game_name: string;
        game_id: string;
        mirror: string | null;
        manual: string | null;
      }>(sql`
        SELECT p.id, p.name_ar AS name, p.kind, pp.price_usd_units::text AS price, g.name_ar AS game_name,
          g.id AS game_id,
          (SELECT o.offer_id FROM product_routes r JOIN supplier_offers o ON o.id = r.offer_id
            WHERE r.product_id = p.id AND r.archived_at IS NULL AND o.offer_id LIKE 'mirror-%' LIMIT 1) AS mirror,
          (SELECT r.id FROM product_routes r JOIN suppliers s ON s.id = r.supplier_id
            WHERE r.product_id = p.id AND r.archived_at IS NULL AND r.enabled AND s.code = 'manual'
            LIMIT 1) AS manual
        FROM catalog_products p
        JOIN catalog_games g ON g.id = p.game_id
        JOIN LATERAL (SELECT price_usd_units FROM product_prices WHERE product_id = p.id AND price_list_id = '${ROOT_PRICE_LIST_IDS.retail}' ORDER BY created_at DESC LIMIT 1) pp ON true
        WHERE p.status = 'active' AND p.archived_at IS NULL AND g.status = 'active' AND g.archived_at IS NULL
        ORDER BY pp.price_usd_units`)
    ).rows;
    const fields = (
      await this.db.execute<{
        game_id: string;
        key: string;
        type: string;
        min_length: number | null;
        max_length: number | null;
        options: { value: string }[] | null;
      }>(sql`SELECT game_id, key, type, min_length, max_length, options FROM catalog_input_fields
        WHERE archived_at IS NULL ORDER BY sort_order`)
    ).rows;
    this.products = rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      priceUnits: Number(row.price),
      gameName: row.game_name,
      mirrorOfferId: row.mirror,
      manualRouteId: row.manual,
      fields: fields
        .filter((field) => field.game_id === row.game_id)
        .map((field) => ({
          key: field.key,
          type: field.type,
          minLength: field.min_length,
          maxLength: field.max_length,
          options: field.options,
        })),
    }));
    this.input.log(`  ${this.products.length} purchasable products`);
  }

  private fieldsFor(product: Product, seed: number): Record<string, string> {
    return Object.fromEntries(
      product.fields.map((field) => {
        if (field.type === 'select')
          return [field.key, field.options?.[seed % field.options.length]?.value ?? ''];
        if (field.type === 'phone')
          return [field.key, `+9639${String(31_000_000 + seed * 7919).slice(0, 8)}`];
        const digits = String(5_100_000_000 + seed * 104_729).slice(
          0,
          Math.min(field.maxLength ?? 10, 10),
        );
        return [field.key, field.type === 'digits' ? digits : `vx${digits}`];
      }),
    );
  }

  private pick(filter: (product: Product) => boolean, at = 0): Product | undefined {
    const matching = this.products.filter(filter);
    return matching[at % Math.max(matching.length, 1)];
  }

  private async buy(
    key: PersonKey,
    product: Product | undefined,
    options: {
      quantity?: number;
      reserve?: boolean;
      save?: string;
      gift?: { senderName?: string; message?: string };
      seed?: number;
    } = {},
  ) {
    if (!product) {
      this.report.skipped.push(`order for ${key}: no matching product`);
      return undefined;
    }
    return this.step(`order ${product.name} for ${key}`, async () => {
      const { order } = await this.get(OrdersService).purchase(
        this.person(key),
        randomUUID(),
        {
          productId: product.id,
          quantity: options.quantity ?? 1,
          fields:
            product.kind === 'direct'
              ? this.fieldsFor(product, options.seed ?? this.counter++)
              : {},
          expectedUnitPriceUsdUnits: product.priceUnits,
          whenBalanceShort: options.reserve ? 'reserve' : 'refuse',
          confirmPlayer: true,
          ...(options.save && { savePlayer: { label: options.save } }),
          ...(options.gift && { gift: options.gift }),
        },
        this.meta(key),
        'cli',
      );
      return order;
    });
  }

  private orderIds: Record<string, string> = {};

  private async orders(): Promise<void> {
    const direct = (product: Product) =>
      product.kind === 'direct' && product.mirrorOfferId !== null;
    const code = (product: Product) => product.kind === 'code' && product.mirrorOfferId !== null;
    const cheap = (product: Product) => product.priceUnits <= usd(12);

    // Outcomes scripted on the fake's twin of chosen packs (S08), cleared once fulfilled.
    // Held: pending at the fake until its 5-minute limit; unknown: one order only, since every
    // re-send of an unknown order counts as an error and three in a row mark the fake down.
    const held = this.pick((p) => direct(p) && cheap(p), 3);
    const unknown = this.pick((p) => direct(p) && cheap(p), 11);
    const pending = this.pick((p) => direct(p) && cheap(p), 5);
    const failing = this.pick((p) => direct(p) && cheap(p), 7);
    const invalid = this.pick((p) => direct(p) && cheap(p), 9);
    const partial = this.pick((p) => code(p) && p.priceUnits <= usd(15), 1);
    const toManual = this.pick((p) => direct(p) && p.manualRouteId !== null);
    const scripts: Record<string, string> = {};
    for (const [product, script] of [
      [held, 'pending'],
      [unknown, 'unknown'],
      [pending, 'pending'],
      [failing, 'failed'],
      [invalid, 'invalid'],
      [partial, 'partial:1'],
      [toManual, 'failed'],
    ] as const) {
      if (product?.mirrorOfferId) scripts[product.mirrorOfferId] = script;
    }
    await this.input.fakeState.setScripts(scripts);
    // The manual route takes over when the fake refuses, once its cost keeps the minimum margin
    // (the copied manual costs may not): set as the panel's "manual cost" does (S07 RT8).
    if (toManual?.manualRouteId) {
      const routeId = toManual.manualRouteId;
      await this.step('manual route cost', () =>
        this.get(RoutesService).setManualCost(
          this.admin,
          routeId,
          Math.max(USD_CENT, toManual.priceUnits - usd(0.3)),
        ),
      );
    }
    // The held pack's twin waits 5 minutes, not the policy's 30, before the order is held for
    // the admin (S17 WR9), so the seed can decide some of its orders and leave one to decide.
    const heldOffer = held?.mirrorOfferId;
    if (heldOffer) {
      await this.step('5-minute hard limit', () =>
        this.db.execute(sql`UPDATE product_routes
          SET hard_limit_minutes = 5, expected_delivery_minutes = NULL
          WHERE archived_at IS NULL AND offer_id IN
            (SELECT id FROM supplier_offers WHERE offer_id = ${heldOffer})`),
      );
    }

    // Everyday deliveries across the customers (dashboard, reports, live activity).
    const buyers: PersonKey[] = [
      'ahmad',
      'sara',
      'mohammad',
      'omar',
      'reem',
      'hasan',
      'zainab',
      'yousef',
      'khaled',
      'tarek',
    ];
    let at = 0;
    for (const key of buyers) {
      for (let round = 0; round < (key === 'ahmad' ? 6 : 3); round += 1) {
        const product = this.pick(
          (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
          at * 3 + 11,
        );
        await this.buy(key, product, { seed: at });
        at += 1;
      }
    }
    await this.buy(
      'ahmad',
      this.pick((p) => code(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string)),
      { quantity: 2 },
    );
    await this.buy(
      'sara',
      this.pick(
        (p) => code(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
        2,
      ),
    );
    await this.buy(
      'ahmad',
      this.pick(
        (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
        20,
      ),
      {
        save: 'حسابي الأساسي',
        seed: 901,
      },
    );
    await this.buy(
      'ahmad',
      this.pick(
        (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
        21,
      ),
      {
        save: 'حساب أخي',
        seed: 902,
      },
    );
    const gift = await this.buy(
      'ahmad',
      this.pick(
        (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
        22,
      ),
      {
        gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير يا بطل' },
        seed: 903,
      },
    );
    if (gift) this.orderIds.gift = gift.id;

    // Scripted outcomes, each followed by two plain deliveries: three failed calls in a row
    // would mark the fake supplier down (rule H2) and every pack unavailable.
    const fillers: PersonKey[] = ['ahmad', 'sara', 'omar', 'mohammad'];
    let filled = 0;
    const scripted = async (...args: Parameters<Scenarios['buy']>) => {
      const order = await this.buy(...args);
      for (let round = 0; round < 2; round += 1) {
        await this.buy(
          fillers[filled % fillers.length] as PersonKey,
          this.pick(
            (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
            80 + filled,
          ),
          { seed: 2000 + filled },
        );
        filled += 1;
      }
      return order;
    };
    const heldOrder = await scripted('layla', held, { seed: 1001 });
    if (heldOrder) this.orderIds.held = heldOrder.id;
    const refundable = await scripted('omar', held, { seed: 1002 });
    if (refundable) this.orderIds.refundable = refundable.id;
    await scripted('ahmad', held, { seed: 1008 });
    await scripted('zainab', unknown, { seed: 1009 });
    await scripted('reem', pending, { seed: 1003 });
    await scripted('hasan', failing, { seed: 1004 });
    await scripted('yousef', invalid, { seed: 1005 });
    if (partial) await scripted('sara', partial, { quantity: 3 });
    const manual = await scripted('khaled', toManual, { seed: 1006 });
    if (manual) this.orderIds.manual = manual.id;
    await scripted('hasan', toManual, { seed: 1007 });

    // Layla's balance is short: reserved orders (S09), one cancelled by her.
    const reserved = await this.buy(
      'layla',
      this.pick((p) => direct(p) && p.priceUnits > usd(5) && p.priceUnits <= usd(20)),
      { reserve: true, seed: 1101 },
    );
    const cancelled = await this.buy(
      'layla',
      this.pick((p) => direct(p) && p.priceUnits > usd(5) && p.priceUnits <= usd(20), 2),
      { reserve: true, seed: 1102 },
    );
    if (cancelled) {
      await this.step('cancel reservation', () =>
        this.get(OrdersService).cancel(this.person('layla'), cancelled.id, this.meta('layla')),
      );
    }
    if (reserved) this.orderIds.reserved = reserved.id;

    // A cart of three lines (S10).
    await this.step('checkout of three lines', async () => {
      const lines = [0, 4, 8]
        .map((index) =>
          this.pick(
            (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
            40 + index,
          ),
        )
        .filter((product): product is Product => product !== undefined)
        .map((product, index) => ({
          productId: product.id,
          quantity: 1,
          fields: this.fieldsFor(product, 1200 + index),
          expectedUnitPriceUsdUnits: product.priceUnits,
          confirmPlayer: true,
        }));
      return this.get(OrdersService).checkout(
        this.person('mohammad'),
        randomUUID(),
        { lines, source: 'cart' },
        this.meta('mohammad'),
        'cli',
      );
    });

    // Test customers buy through the fake only (S08 R4).
    await this.buy(
      'tc1',
      this.pick(
        (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
        50,
      ),
      { seed: 1301 },
    );
    await this.buy(
      'tc1',
      this.pick(
        (p) => code(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
        3,
      ),
    );

    // The panel's own purchases (S16 AP1–AP15).
    const purchases = this.get(AdminPurchasesService);
    const adminProduct = (at: number) =>
      this.pick(
        (p) => direct(p) && cheap(p) && !Object.hasOwn(scripts, p.mirrorOfferId as string),
        at,
      );
    for (const [purpose, customer, at] of [
      ['walk_in', undefined, 60],
      ['on_behalf', 'nour', 61],
      ['gift', 'tc2', 62],
      ['compensation', 'omar', 63],
    ] as const) {
      const product = adminProduct(at);
      if (!product) continue;
      await this.step(`admin purchase ${purpose}`, () =>
        purchases.create(this.admin, randomUUID(), {
          productId: product.id,
          quantity: 1,
          fields: this.fieldsFor(product, 1400 + at),
          expectedUnitPriceUsdUnits: product.priceUnits,
          confirmPlayer: true,
          purpose,
          ...(customer && { customerId: this.person(customer) }),
          reason: 'طلب من لوحة الإدارة أثناء تجهيز البيانات',
          ...((purpose === 'gift' || purpose === 'compensation') && {
            customerNote: 'هدية من فريق Vertex Digital',
          }),
        }),
      );
    }

    this.input.log('  waiting for the worker to fulfil the orders');
    await this.waitForWorker();
    await this.input.fakeState.setScripts({});
  }

  /** Waits until no order is paid but not yet sent and no attempt is still being sent. */
  private async waitForWorker(): Promise<void> {
    for (let round = 0; round < 90; round += 1) {
      const { rows } = await this.db.execute<{ waiting: number }>(sql`
        SELECT (SELECT count(*) FROM orders WHERE status = 'paid')::int
          + (SELECT count(*) FROM fulfilment_attempts WHERE status = 'sending')::int AS waiting`);
      if ((rows[0]?.waiting ?? 0) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    this.report.skipped.push(
      'worker: orders still waiting after 3 minutes (is `pnpm dev` running?)',
    );
  }

  private async orderDecisions(): Promise<void> {
    const decisions = this.get(OrderDecisionsService);
    const actions = this.get(OrderActionsService);
    const openAttempt = async (orderId: string | undefined) =>
      orderId
        ? (
            await this.db.execute<{ id: string }>(
              sql`SELECT id FROM fulfilment_attempts WHERE order_id = ${orderId} ORDER BY created_at DESC LIMIT 1`,
            )
          ).rows[0]?.id
        : undefined;

    // The held pack's orders wait for the admin once their 5-minute limit passes.
    const held = [this.orderIds.held, this.orderIds.refundable].filter(
      (id): id is string => id !== undefined,
    );
    if (held.length > 0) {
      this.input.log('  waiting for the held orders to need a review (about 5 minutes)');
      for (let round = 0; round < 60; round += 1) {
        const { rows } = await this.db.execute<{ held: number }>(
          sql`SELECT count(*)::int AS held FROM orders WHERE status = 'needs_review' AND id IN ${held}`,
        );
        if ((rows[0]?.held ?? 0) === held.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }

    const heldAttempt = await openAttempt(this.orderIds.held);
    if (this.orderIds.held && heldAttempt) {
      await this.step('resolve a held order as delivered', () =>
        decisions.resolve(this.admin, this.orderIds.held as string, heldAttempt, randomUUID(), {
          outcome: 'delivered',
          quantity: 1,
          codes: [],
          reason: 'تأكدنا من كشف المورد أن الطلب سُلّم',
        }),
      );
    }
    if (this.orderIds.refundable) {
      await this.step('admin refund', () =>
        decisions.refund(
          this.admin,
          this.orderIds.refundable as string,
          randomUUID(),
          'استرداد بطلب العميل بعد خطأ في المعرف',
        ),
      );
    }
    if (this.orderIds.manual) {
      await this.step('manual fulfil with proof', async () => {
        const proof = await actions.uploadProof(
          this.admin,
          this.orderIds.manual as string,
          await noteImage({
            title: 'Delivery proof',
            line: 'Top-up completed manually',
            tint: '#0F3D3E',
          }),
        );
        const order = await decisions.order(this.orderIds.manual as string);
        return actions.fulfil(this.admin, this.orderIds.manual as string, randomUUID(), {
          quantity: 1,
          codes: [],
          unitCostUsdUnits: Math.max(USD_CENT, order.unitPriceUsdUnits - usd(0.2)),
          acceptLoss: false,
          proofFileId: proof.fileId,
          reference: 'MANUAL-001',
          reason: 'نُفّذ يدويًا من حساب المورد الاحتياطي',
        });
      });
    }
    const shares = this.get(ShareLinksService);
    const ahmad = this.person('ahmad');
    const delivered = (
      await this.db.execute<{ id: string }>(
        sql`SELECT id FROM orders WHERE customer_id = ${ahmad} AND status = 'delivered' AND gift_sender_name IS NULL ORDER BY created_at LIMIT 2`,
      )
    ).rows;
    if (delivered[0]) {
      await this.step('receipt link', () =>
        shares.receiptLink(ahmad, delivered[0]?.id as string, {
          showPrice: true,
          playerDisplay: 'masked',
          branded: true,
        }),
      );
    }
    if (delivered[1]) {
      await this.step('receipt link revoked', async () => {
        const link = await shares.receiptLink(ahmad, delivered[1]?.id as string, {
          showPrice: false,
          playerDisplay: 'masked',
          branded: true,
        });
        await shares.revoke(ahmad, delivered[1]?.id as string, link.id);
        return link;
      });
    }

    const codes = (
      await this.db.execute<{ order_id: string; id: string }>(
        sql`SELECT c.order_id, c.id FROM order_codes c JOIN orders o ON o.id = c.order_id WHERE o.customer_id = ${ahmad} ORDER BY c.position LIMIT 1`,
      )
    ).rows[0];
    if (codes) {
      await this.step('customer reveals a code', () =>
        this.get(OrdersService).reveal(ahmad, codes.order_id, codes.id, this.meta('ahmad')),
      );
    }
  }

  // Customers in the panel --------------------------------------------------------------------

  private async customerAdmin(): Promise<void> {
    const service = this.get(CustomersService);
    await this.step('freeze khaled', () =>
      service.changeState(
        'freeze',
        this.person('khaled'),
        'نشاط مشبوه: نفس الهاتف لحسابين',
        this.admin.adminId,
        ADMIN_META,
      ),
    );
    // An account is archived with an empty wallet (S12): Tarek takes his balance back in cash.
    const balance = await this.get(WalletService).balanceOf(this.person('tarek'));
    if (balance > 0) {
      await this.adjust('tarek', {
        direction: 'debit',
        amountUnits: balance,
        category: 'cash_refund',
        reason: 'إعادة الرصيد نقدًا قبل إغلاق الحساب',
      });
    }
    await this.step('archive tarek', () =>
      service.changeState(
        'archive',
        this.person('tarek'),
        'طلب العميل إغلاق حسابه',
        this.admin.adminId,
        ADMIN_META,
      ),
    );
    await this.step('notes', async () => {
      await service.addNote(
        this.person('ahmad'),
        { body: 'عميل دائم، يفضّل التواصل عبر تيليجرام', pinned: true },
        this.admin.adminId,
        ADMIN_META,
      );
      await service.addNote(
        this.person('ahmad'),
        { body: 'طلب فاتورة شهرية', pinned: false },
        this.admin.adminId,
        ADMIN_META,
      );
      const old = await service.addNote(
        this.person('khaled'),
        { body: 'تواصل معنا بخصوص إيداع مرفوض', pinned: false },
        this.admin.adminId,
        ADMIN_META,
      );
      return service.changeNote(
        this.person('khaled'),
        old.id,
        'archive',
        this.admin.adminId,
        ADMIN_META,
      );
    });
    await this.step('limits for omar', () =>
      service.setLimits(
        this.person('omar'),
        {
          perDepositUsdUnits: usd(500),
          dailyDepositUsdUnits: usd(1500),
          dailyPurchaseUsdUnits: usd(300),
          reason: 'تاجر جملة موثوق',
        },
        this.admin.adminId,
        ADMIN_META,
      ),
    );
    await this.step('push device for ahmad', async () => {
      const customerId = this.person('ahmad');
      const sessionId = await createDevSession(this.db, customerId, {
        ipAddress: this.meta('ahmad').ipAddress as string,
        userAgent: DEVICES[0] as string,
      });
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      return this.get(PushService).register(
        { id: customerId, sessionId },
        {
          endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(16).toString('hex')}`,
          keys: {
            p256dh: ecdh.getPublicKey().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
          },
        },
      );
    });
  }

  // Support -----------------------------------------------------------------------------------

  private async support(): Promise<void> {
    const customer = this.get(SupportService);
    const admin = this.get(SupportAdminService);
    const screenshot = await noteImage({
      title: 'Screenshot',
      line: 'The top-up did not arrive',
      tint: '#8A1C1C',
    });
    const reem = this.person('reem');
    const pendingOrder = (
      await this.db.execute<{ id: string }>(
        sql`SELECT id FROM orders WHERE customer_id = ${reem} ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    await this.step('ticket about an order', async () => {
      const { ticket } = await customer.open(
        reem,
        randomUUID(),
        {
          category: 'order',
          orderId: pendingOrder?.id,
          subject: 'الطلب لم يصل بعد',
          body: 'مرّ وقت طويل ولم يصل الشحن إلى حسابي، أرفقت لقطة الشاشة.',
        },
        [screenshot],
        this.meta('reem'),
      );
      await admin.reply(
        this.admin.adminId,
        ticket.id,
        randomUUID(),
        'نتابع طلبك مع المورد وسنعلمك خلال دقائق.',
        [],
        ADMIN_META,
      );
      return ticket;
    });
    await this.step('ticket answered and closed', async () => {
      const { ticket } = await customer.open(
        this.person('sara'),
        randomUUID(),
        {
          category: 'account',
          subject: 'تغيير رقم الهاتف',
          body: 'أريد تغيير رقم الهاتف المرتبط بحسابي.',
        },
        [],
        this.meta('sara'),
      );
      await admin.reply(
        this.admin.adminId,
        ticket.id,
        randomUUID(),
        'أرسل الرقم الجديد وسنحدّثه بعد التحقق.',
        [],
        ADMIN_META,
      );
      await customer.reply(
        this.person('sara'),
        ticket.id,
        randomUUID(),
        'الرقم الجديد مرسل في رسالة خاصة، شكرًا.',
        [],
        this.meta('sara'),
      );
      return admin.close(this.admin.adminId, ticket.id, ADMIN_META);
    });
    await this.step('ticket about a deposit', async () => {
      const deposit = (
        await this.db.execute<{ id: string }>(
          sql`SELECT id FROM deposits WHERE customer_id = ${this.person('tarek')} ORDER BY created_at DESC LIMIT 1`,
        )
      ).rows[0];
      return customer.open(
        this.person('tarek'),
        randomUUID(),
        {
          category: 'deposit',
          depositId: deposit?.id,
          subject: 'إيداعي مرفوض',
          body: 'حوّلت المبلغ فعلًا، لماذا رُفض الإيداع؟',
        },
        [],
        this.meta('tarek'),
      );
    });
    await this.step('ticket closed by the customer', async () => {
      const { ticket } = await customer.open(
        this.person('hasan'),
        randomUUID(),
        {
          category: 'other',
          subject: 'استفسار عن الأسعار',
          body: 'هل توجد أسعار جملة؟',
        },
        [],
        this.meta('hasan'),
      );
      return customer.close(this.person('hasan'), ticket.id, this.meta('hasan'));
    });
    await this.step('ticket opened by the admin', () =>
      admin.open(
        this.admin.adminId,
        randomUUID(),
        {
          customerId: this.person('nour'),
          category: 'account',
          subject: 'تأكيد بيانات الحساب',
          body: 'مرحبًا، نحتاج تأكيد رقم هاتفك لإكمال مراجعة إيداعك.',
        },
        [],
        ADMIN_META,
      ),
    );
  }

  // Treasury and reconciliation ---------------------------------------------------------------

  private async treasury(): Promise<void> {
    const treasury = this.get(TreasuryService);
    const move = (
      name: string,
      body: Omit<Parameters<TreasuryService['create']>[2], 'openingBalance'> & {
        openingBalance?: boolean;
      },
    ) =>
      this.step(name, () =>
        treasury.create(
          this.admin.adminId,
          randomUUID(),
          {
            openingBalance: false,
            ...body,
            ...(body.sentUnits > usd(100) && { amountConfirmationUnits: body.sentUnits }),
          },
          ADMIN_META,
        ),
      );
    await move('opening Sham Cash USD', {
      from: 'outside_usd',
      to: 'sham_cash_usd',
      sentUnits: usd(1500),
      receivedUnits: usd(1500),
      outsideCategory: 'owner',
      openingBalance: true,
      reason: 'الرصيد الافتتاحي لحساب شام كاش بالدولار',
    });
    await move('opening Sham Cash SYP', {
      from: 'outside_syp',
      to: 'sham_cash_syp',
      sentUnits: 9_000_000 * 100,
      receivedUnits: 9_000_000 * 100,
      outsideCategory: 'owner',
      openingBalance: true,
      reason: 'الرصيد الافتتاحي لحساب شام كاش بالليرة',
    });
    await move('opening USDT TRC20', {
      from: 'outside_usd',
      to: 'usdt_trc20',
      sentUnits: usd(400),
      receivedUnits: usd(400),
      outsideCategory: 'owner',
      openingBalance: true,
      reason: 'الرصيد الافتتاحي لمحفظة USDT TRC20',
    });
    await move('opening USDT BEP20', {
      from: 'outside_usd',
      to: 'usdt_bep20',
      sentUnits: usd(200),
      receivedUnits: usd(200),
      outsideCategory: 'owner',
      openingBalance: true,
      reason: 'الرصيد الافتتاحي لمحفظة USDT BEP20',
    });
    await move('opening fake supplier', {
      from: 'outside_usd',
      to: 'supplier:fake',
      sentUnits: usd(1000),
      receivedUnits: usd(1000),
      outsideCategory: 'owner',
      openingBalance: true,
      reason: 'الرصيد الافتتاحي لدى المورد التجريبي',
    });
    await move('top up the fake supplier', {
      from: 'usdt_trc20',
      to: 'supplier:fake',
      sentUnits: usd(150),
      receivedUnits: usd(149),
      reason: 'تحويل USDT لشحن رصيد المورد',
      externalReference: this.reference('TX'),
    });
    const wrong = await move('unclaimed receipt', {
      from: 'outside_usd',
      to: 'sham_cash_usd',
      sentUnits: usd(20),
      receivedUnits: usd(20),
      outsideCategory: 'unclaimed_receipt',
      reason: 'حوالة وصلت بلا إيداع مطابق',
    });
    if (wrong) {
      await this.step('reverse a movement', () =>
        treasury.reverse(
          this.admin.adminId,
          wrong.movement.id,
          randomUUID(),
          { reason: 'تبيّن أنها حوالة إيداع مسجّلة' },
          ADMIN_META,
        ),
      );
    }
    await this.step('supplier correction', () =>
      treasury.correct(
        this.admin.adminId,
        randomUUID(),
        {
          supplier: 'fake',
          direction: 'increase',
          amountUnits: usd(2.5),
          reason: 'المورد أعاد رسوم طلب فاشل',
        },
        ADMIN_META,
      ),
    );

    const reconciliation = this.get(ReconciliationService);
    await this.step('Sham Cash count', () =>
      reconciliation.count(
        this.admin.adminId,
        randomUUID(),
        { currency: 'USD', countedUnits: usd(1580) },
        ADMIN_META,
      ),
    );
    await this.step('manual reconciliation run', () =>
      reconciliation.startManual(this.admin.adminId, ADMIN_META),
    );
  }

  // Pricing -----------------------------------------------------------------------------------

  private async pricing(): Promise<void> {
    const pricing = this.get(PricingService);
    const game = (
      await this.db.execute<{ id: string }>(
        sql`SELECT id FROM catalog_games WHERE slug = 'free-fire' AND archived_at IS NULL LIMIT 1`,
      )
    ).rows[0];
    const existing = game
      ? (await pricing.rules()).find((rule) => rule.scope === 'game' && rule.targetId === game.id)
      : undefined;
    if (game && !existing) {
      await this.step('margin rule for Free Fire', () =>
        pricing.setRule(
          this.admin.adminId,
          {
            scope: 'game',
            targetId: game.id,
            percentBp: 800,
            fixedUsdUnits: 0,
            minMarginUsdUnits: usd(0.1),
          },
          ADMIN_META,
        ),
      );
    }
    // The next sync of the fake sees a cost 25% higher on one pack: a price review (S07).
    const product = this.pick(
      (p) => p.kind === 'direct' && p.mirrorOfferId !== null && p.priceUnits > usd(2),
      70,
    );
    if (product?.mirrorOfferId) {
      const cost = (
        await this.db.execute<{ cost: string }>(
          sql`SELECT cost_usd_units::text AS cost FROM supplier_offers WHERE offer_id = ${product.mirrorOfferId}`,
        )
      ).rows[0];
      if (cost)
        await this.input.fakeState.setCost(
          product.mirrorOfferId,
          Math.round(Number(cost.cost) * 1.25),
        );
    }
  }
}

/** A fake USDT transfer through the worker's CLI (S04; `CHAIN_READER=fake`). */
function fakeTransfer(args: string[]): void {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@vertex-digital/worker', 'usdt:fake-transfer', ...args],
    { encoding: 'utf8', shell: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `usdt:fake-transfer failed: ${(result.stderr || result.stdout).trim().slice(-300)}`,
    );
  }
}
