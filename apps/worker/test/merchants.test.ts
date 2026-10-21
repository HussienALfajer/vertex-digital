import { damascusMonth, monthRange } from '@vertex-digital/contracts';
import {
  createDatabase,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  merchantApplications,
  newId,
  postJournal,
} from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { renderEmail } from '../src/jobs/email/email-templates.js';
import { ExpireApplicationsJob } from '../src/jobs/merchants/expire-applications.job.js';
import { MerchantLevelJob } from '../src/jobs/merchants/level.job.js';
import { MerchantStatementEmailsJob } from '../src/jobs/merchants/statement-emails.job.js';
import { MerchantWatchAlertsJob } from '../src/jobs/merchants/watch-alerts.job.js';
import { renderTelegramMessage } from '../src/telegram/messages.js';

/*
 * Merchant applications in the worker (S20 MA4, Jobs): the expiry job against the test database
 * (committed rows: the job opens a transaction per application, as in production), and the
 * Telegram notice of a new application.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
const pgBoss = { boss: { send: async () => null } } as unknown as PgBossService;
const LINKS = { admin: 'https://admin.example', store: 'https://store.example' };

afterAll(() => connection.close());

/** An application of a new customer, waiting for information since `daysAgo`. */
async function waiting(daysAgo: number): Promise<string> {
  const customerId = newId();
  await db.insert(customers).values({
    id: customerId,
    name: 'Shop',
    email: `${customerId}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  const versionId = newId();
  await db.execute(sql`insert into content_page_versions
    (id, page, version, title, body, draft_revision, admin_id)
    values (${versionId}, 'merchant_terms', 1000 + floor(random() * 1e9)::int, 'شروط', 'نص', 1, ${newId()})`);
  const id = newId();
  await db.insert(merchantApplications).values({
    id,
    customerId,
    tradeName: 'محل النور',
    activity: 'phone_shop',
    yearsInBusiness: '1_3',
    governorate: 'aleppo',
    city: 'اعزاز',
    streetAddress: 'شارع السوق',
    whatsapp: '+963933123456',
    monthlyVolume: '500_2000',
    productInterests: ['game_topups'],
    salesChannels: ['shop_counter'],
    termsVersionId: versionId,
    idempotencyKey: newId(),
  });
  await db.execute(sql`update merchant_applications set status = 'info_requested',
    info_requested_at = now() - make_interval(days => ${daysAgo}) where id = ${id}`);
  return id;
}

const statusOf = async (id: string) =>
  (
    await db
      .select({ status: merchantApplications.status })
      .from(merchantApplications)
      .where(eq(merchantApplications.id, id))
  )[0]?.status;

describe('merchants.expire-applications (MA4)', () => {
  it('expires requests past info_expiry_days once, and leaves newer ones', async () => {
    const job = new ExpireApplicationsJob(pgBoss, db);
    const due = await waiting(8);
    const fresh = await waiting(2);
    expect(await job.run(new Date())).toBeGreaterThanOrEqual(1);
    expect(await statusOf(due)).toBe('expired');
    expect(await statusOf(fresh)).toBe('info_requested');
    // A second run finds nothing more to do.
    expect(await job.run(new Date())).toBe(0);
    const { rows } = await db.execute<{ event: string }>(
      sql`select event from merchant_application_events where application_id = ${due}`,
    );
    expect(rows).toEqual([{ event: 'expired' }]);
  });
});

describe('the merchant application notice (Jobs)', () => {
  it('names no person: the link and the waiting count', () => {
    const applicationId = newId();
    const text = renderTelegramMessage(
      'merchant_application',
      { applicationId, resubmitted: false, waiting: 2 },
      LINKS,
    ).text;
    expect(text).toBe(
      [
        '🏪 طلب تاجر جديد بانتظار المراجعة',
        'بانتظار المراجعة: 2',
        `https://admin.example/merchants/applications/${applicationId}`,
      ].join('\n'),
    );
    expect(
      renderTelegramMessage(
        'merchant_application',
        { applicationId, resubmitted: true, waiting: 1 },
        LINKS,
      ).text,
    ).toContain('أُعيد إرساله');
  });
});

/** A merchant of their own, with alert settings. */
async function merchant(settings: { dailyEmail?: boolean } = {}): Promise<string> {
  const customerId = newId();
  await db.insert(customers).values({
    id: customerId,
    name: 'Shop',
    email: `${customerId}@test.vertex-digital.local`,
    phone: '+963900000000',
    emailVerified: true,
    accountType: 'merchant',
  });
  await db.execute(sql`insert into merchant_profiles (customer_id, trade_name, governorate, city, granted_at)
    values (${customerId}, 'محل النور', 'aleppo', 'اعزاز', now())`);
  if (settings.dailyEmail) {
    await db.execute(sql`insert into merchant_alert_settings (customer_id, daily_email)
      values (${customerId}, true)`);
  }
  return customerId;
}

/** A product of a hidden test game, for alert events. */
async function product(): Promise<string> {
  const [category, game, id] = [newId(), newId(), newId()];
  const tag = newId().slice(-12);
  await db.execute(sql`insert into catalog_categories (id, slug, name_ar, sort_order, archived_at)
    values (${category}, ${`mc-${tag}`}, ${`فئة ${tag}`}, 99, now())`);
  await db.execute(sql`insert into catalog_games (id, category_id, slug, name_ar, name_en, sort_order)
    values (${game}, ${category}, ${`mg-${tag}`}, ${`لعبة ${tag}`}, 'Game', 1)`);
  await db.execute(sql`insert into catalog_products (id, game_id, kind, name_ar, max_quantity, sort_order)
    values (${id}, ${game}, 'direct', ${`باقة ${tag}`}, 1, 1)`);
  return id;
}

describe('merchant tools jobs (S21 LV4, AL2, AL4)', () => {
  const env = { SUPPLIER_FAKE_ENABLED: true } as Env;

  it('recomputes a level twice to the same state', async () => {
    const job = new MerchantLevelJob(pgBoss, db);
    const shop = await merchant();
    const first = await job.recompute(shop, new Date());
    expect(await job.recompute(shop, new Date())).toEqual({ changed: false });
    expect(first.changed === false || first.levelIdAfter !== undefined).toBe(true);
  });

  it('compares follows and sends the daily email once a day', async () => {
    const job = new MerchantWatchAlertsJob(pgBoss, db, env);
    expect(await job.compareAll(new Date())).toBeGreaterThanOrEqual(0);
    const shop = await merchant({ dailyEmail: true });
    const productId = await product();
    await db.execute(sql`insert into merchant_alert_events (id, customer_id, product_id, kind,
      old_price_usd_units, new_price_usd_units)
      values (${newId()}, ${shop}, ${productId}, 'price_down', 1500000, 1200000)`);
    const quiet = await merchant({ dailyEmail: true });
    await job.digestAll(new Date());
    await job.digestAll(new Date());
    const sent = async (customerId: string) =>
      (
        await db.execute<{ params: { total: number } }>(
          sql`select params from email_outbox where customer_id = ${customerId}
            and template = 'customer_merchant_daily_digest'`,
        )
      ).rows;
    expect(await sent(shop)).toEqual([
      {
        params: expect.objectContaining({
          total: 1,
          lines: [expect.objectContaining({ kind: 'price_down' })],
        }),
      },
    ]);
    expect(await sent(quiet)).toEqual([]);
  });
});

describe('merchants.statement-emails (S21 ST4)', () => {
  it('tells a merchant with entries of the month once, and no one without', async () => {
    const job = new MerchantStatementEmailsJob(pgBoss, db);
    const active = await merchant();
    const quiet = await merchant();
    await db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, active), amountUnits: 1_000_000 },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -1_000_000,
          },
        ],
      });
    });
    // On the 1st of next month, this month is the last one.
    const month = damascusMonth(new Date());
    const nextFirst = new Date(monthRange(month).end.getTime() + 8 * 60 * 60 * 1000);
    expect(await job.sendAll(nextFirst)).toBeGreaterThanOrEqual(1);
    await job.sendAll(nextFirst);
    const told = async (customerId: string) =>
      (
        await db.execute<{ params: { month: string } }>(
          sql`select params from customer_notifications where customer_id = ${customerId}
            and event = 'merchant_statement_ready'`,
        )
      ).rows;
    expect(await told(active)).toEqual([{ params: { month } }]);
    expect(await told(quiet)).toEqual([]);
    const emails = await db.execute(
      sql`select 1 from email_outbox where customer_id = ${active}
        and template = 'customer_merchant_statement_ready'`,
    );
    expect(emails.rows).toHaveLength(1);
  });
});

describe('the merchant tools emails (S21)', () => {
  const store = 'https://digital.example';

  it('names the level and the price kind, never a list', () => {
    const email = renderEmail(
      'customer_merchant_level_changed',
      { levelNameAr: 'فضي', priceKind: 'special', direction: 'up' },
      store,
    );
    expect(email.text).toContain('أسعار خاصة');
    expect(email.text).toContain('https://digital.example/merchant');
    expect(
      renderEmail(
        'customer_merchant_level_changed',
        { levelNameAr: null, priceKind: 'wholesale', direction: 'down' },
        store,
      ).text,
    ).toContain('لم يعد حسابك ضمن أي مستوى');
  });

  it('gives the balance and the threshold, and lists a day of changes', () => {
    const low = renderEmail(
      'customer_merchant_low_balance',
      { balanceUsdUnits: 4_500_000, thresholdUsdUnits: 10_000_000, at: '2026-10-21T09:00:00.000Z' },
      store,
    );
    expect(low.text).toContain('$4.50');
    expect(low.text).toContain('$10.00');
    const line = {
      productId: newId(),
      gameNameAr: 'ببجي',
      productNameAr: '660 شدة',
      oldPriceUsdUnits: null,
      newPriceUsdUnits: null,
    };
    const digest = renderEmail(
      'customer_merchant_daily_digest',
      {
        total: 3,
        lines: [
          { ...line, kind: 'price_up', oldPriceUsdUnits: 1_000_000, newPriceUsdUnits: 1_100_000 },
          { ...line, kind: 'out_of_stock' },
        ],
      },
      store,
    );
    expect(digest.text).toContain('ارتفع سعر');
    expect(digest.text).toContain('نفدت');
    expect(digest.text).toContain('تغيّرات أخرى');
  });

  it("links last month's statement by the month's name", () => {
    const email = renderEmail('customer_merchant_statement_ready', { month: '2026-09' }, store);
    expect(email.subject).toContain('2026');
    expect(email.text).toContain('https://digital.example/merchant/statements/2026-09');
  });
});
