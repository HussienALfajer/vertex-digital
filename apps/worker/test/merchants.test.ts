import {
  damascusMonth,
  monthRange,
  QUEUES,
  TIER_NAMES_AR,
  TIER_SETTINGS_DEFAULTS,
} from '@vertex-digital/contracts';
import {
  createDatabase,
  customers,
  type Database,
  earlyAccessEndedBetween,
  ensureCustomerWallet,
  ensureSystemAccount,
  merchantApplications,
  merchantsToCompare,
  merchantTierSettings,
  newId,
  type OverdueTicket,
  overdueTickets,
  postJournal,
  statementEmailMerchants,
  supportTickets,
  type Transaction,
  tellTicketOverdue,
} from '@vertex-digital/db';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import {
  CatalogEarlyAccessEndJob,
  EARLY_ACCESS_END_LOOKBACK_MS,
} from '../src/jobs/catalog/early-access-end.job.js';
import { renderEmail } from '../src/jobs/email/email-templates.js';
import { ExpireApplicationsJob } from '../src/jobs/merchants/expire-applications.job.js';
import { MerchantLevelJob } from '../src/jobs/merchants/level.job.js';
import { MerchantStatementEmailsJob } from '../src/jobs/merchants/statement-emails.job.js';
import { MerchantTierGrantsJob } from '../src/jobs/merchants/tier-grants.job.js';
import { MerchantTierRemindersJob } from '../src/jobs/merchants/tier-reminders.job.js';
import { MerchantWatchAlertsJob } from '../src/jobs/merchants/watch-alerts.job.js';
import { renderPush } from '../src/jobs/push/push-texts.js';
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

/**
 * The database with its `failAt`-th transaction (from 0) refused: the job's merchant at that place
 * in its list throws (audit A06-33). `calls` counts the transactions asked for.
 */
function poisoned(failAt: number) {
  const state = { calls: 0 };
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (...args: Parameters<Database['transaction']>) =>
        state.calls++ === failAt
          ? Promise.reject(new Error('A poisoned merchant'))
          : target.transaction(...args);
    },
  });
  return { db: proxy as Database, state };
}

/** A wallet entry of `amountUnits` for the customer, this month. */
async function credit(customerId: string, amountUnits = 1_000_000) {
  await db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customerId), amountUnits },
        {
          accountId: await ensureSystemAccount(tx, {
            code: 'adjustments:test_funds',
            kind: 'adjustments',
            currency: 'USD',
          }),
          amountUnits: -amountUnits,
        },
      ],
    });
  });
}

describe('one failing merchant in the merchant jobs (audit A06-33)', () => {
  const env = { SUPPLIER_FAKE_ENABLED: true } as Env;

  it('A06-33: tells the merchants after a failing one their statement, then fails the run', async () => {
    const poison = await merchant();
    const active = await merchant();
    await credit(poison);
    await credit(active);
    const month = damascusMonth(new Date());
    const nextFirst = new Date(monthRange(month).end.getTime() + 8 * 60 * 60 * 1000);
    const list = await statementEmailMerchants(db, month);
    expect(list.indexOf(poison)).toBeLessThan(list.indexOf(active));
    const { db: failing, state } = poisoned(list.indexOf(poison));
    const job = new MerchantStatementEmailsJob(pgBoss, failing);
    await expect(job.sendAll(nextFirst)).rejects.toThrow(
      'Statement notices failed for 1 merchants',
    );
    expect(state.calls).toBe(list.length);
    const told = async (customerId: string) =>
      (
        await db.execute(
          sql`select 1 from customer_notifications where customer_id = ${customerId}
            and event = 'merchant_statement_ready'`,
        )
      ).rows.length;
    expect(await told(active)).toBe(1);
    expect(await told(poison)).toBe(0);
    // The retry tells the one that failed, and nobody twice.
    await new MerchantStatementEmailsJob(pgBoss, db).sendAll(nextFirst);
    expect([await told(active), await told(poison)]).toEqual([1, 1]);
  });

  it('A06-33: compares and digests every merchant after a failing one, then fails the run', async () => {
    const productId = await product();
    const [{ gameId } = { gameId: '' }] = (
      await db.execute<{ gameId: string }>(
        sql`select game_id as "gameId" from catalog_products where id = ${productId}`,
      )
    ).rows;
    for (let index = 0; index < 2; index += 1) {
      const shop = await merchant({ dailyEmail: true });
      await db.execute(sql`insert into merchant_watches (id, customer_id, game_id)
        values (${newId()}, ${shop}, ${gameId})`);
    }
    const compared = await merchantsToCompare(db);
    expect(compared.length).toBeGreaterThanOrEqual(2);
    const comparing = poisoned(0);
    // Within the hour's first quarter, when every merchant is compared (OP8).
    const hourly = new Date();
    hourly.setUTCMinutes(5);
    await expect(
      new MerchantWatchAlertsJob(pgBoss, comparing.db, env).compareAll(hourly),
    ).rejects.toThrow('Watch comparison failed for 1 merchants');
    expect(comparing.state.calls).toBe(compared.length);
    const digesting = poisoned(0);
    const job = new MerchantWatchAlertsJob(pgBoss, digesting.db, env);
    await expect(job.digestAll(new Date())).rejects.toThrow('Daily digest failed for 1 merchants');
    expect(digesting.state.calls).toBeGreaterThanOrEqual(2);
  });
});

class Rollback extends Error {}

/** `work` on a transaction that is rolled back, with the live tier levels moved aside in it. */
async function inRollback(work: (tx: Transaction) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await tx.execute(sql`update merchant_levels set archived_at = now()
        where archived_at is null`);
      await work(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

describe('merchant tiers in the worker (S23 TR6, MG4, MG5, PG5)', () => {
  const DAY = 86_400_000;
  /** A live Gold level out of reach, on the wholesale list. */
  const goldLevel = async (tx: Transaction) => {
    const [list] = (
      await tx.execute<{ id: string }>(
        sql`select id from price_lists where kind = 'wholesale' and archived_at is null limit 1`,
      )
    ).rows;
    const id = newId();
    await tx.execute(sql`insert into merchant_levels
      (id, tier, name_ar, monthly_threshold_usd_units, price_list_id)
      values (${id}, 'gold', ${TIER_NAMES_AR.gold}, 1000000000000, ${list?.id})`);
    return id;
  };
  /** An open Gold grant of `shop` ending at `endsAt`. */
  const goldGrant = async (tx: Transaction, shop: string, endsAt: Date) => {
    const id = newId();
    await tx.execute(sql`insert into merchant_tier_grants
      (id, customer_id, tier, starts_at, ends_at, reason, admin_id)
      values (${id}, ${shop}, 'gold', ${new Date(endsAt.getTime() - 5 * DAY).toISOString()},
        ${endsAt.toISOString()}, 'شريك جديد في المدينة', ${newId()})`);
    return id;
  };
  const changes = async (tx: Transaction, shop: string) =>
    (
      await tx.execute(sql`select from_tier, to_tier, source from merchant_tier_changes
        where customer_id = ${shop} order by created_at, id`)
    ).rows;
  const telegram = async (tx: Transaction, kind: string, shop: string) =>
    (
      await tx.execute(sql`select dedupe_key from telegram_messages
        where kind = ${kind} and params->>'customerId' = ${shop}`)
    ).rows;

  it("merchants.level records the payload's cause on the change row (TR6)", async () => {
    const shop = await merchant();
    await inRollback(async (tx) => {
      await goldLevel(tx);
      await goldGrant(tx, shop, new Date(Date.now() + 10 * DAY));
      const job = new MerchantLevelJob(pgBoss, tx as unknown as Database);
      expect(await job.recompute(shop, new Date(), 'tiers_changed')).toMatchObject({
        changed: true,
        tierAfter: 'gold',
      });
      expect(await job.recompute(shop, new Date(), 'tiers_changed')).toEqual({ changed: false });
      expect(await changes(tx, shop)).toEqual([
        { from_tier: 'bronze', to_tier: 'gold', source: 'tiers_changed' },
      ]);
    });
  });

  it('merchants.tier-grants ends a due grant and reminds an ending one, once each (MG4, MG5)', async () => {
    const [due, ending] = [await merchant(), await merchant()];
    await inRollback(async (tx) => {
      const now = new Date();
      await goldLevel(tx);
      const dueGrant = await goldGrant(tx, due, new Date(now.getTime() - 60_000));
      const endingGrant = await goldGrant(tx, ending, new Date(now.getTime() + 2 * DAY));
      const levels = new MerchantLevelJob(pgBoss, tx as unknown as Database);
      await levels.recompute(due, new Date(now.getTime() - 2 * 60_000));
      await levels.recompute(ending, now);
      const job = new MerchantTierGrantsJob(pgBoss, tx as unknown as Database);
      const first = await job.run(now);
      expect(first.expired).toEqual([dueGrant]);
      expect(first.reminded).toBeGreaterThanOrEqual(1);
      expect(await job.run(now)).toEqual({ expired: [], reminded: 0 });

      expect(await changes(tx, due)).toEqual([
        { from_tier: 'bronze', to_tier: 'gold', source: 'granted' },
        { from_tier: 'gold', to_tier: 'bronze', source: 'grant_ended' },
      ]);
      const [grant] = (
        await tx.execute(sql`select end_reason from merchant_tier_grants where id = ${dueGrant}`)
      ).rows;
      expect(grant).toEqual({ end_reason: 'expired' });
      expect(await telegram(tx, 'merchant_tier_changed', due)).toHaveLength(2);
      expect(await telegram(tx, 'merchant_tier_grant_ending', ending)).toEqual([
        { dedupe_key: `grant-ending:${endingGrant}` },
      ]);
      expect(await changes(tx, ending)).toEqual([
        { from_tier: 'bronze', to_tier: 'gold', source: 'granted' },
      ]);
    });
  });

  it('merchants.level-schedule recomputes each merchant and records the month once (PG5)', async () => {
    const shop = await merchant();
    const month = damascusMonth(new Date());
    const nextFirst = new Date(monthRange(month).end.getTime() + 10 * 60 * 1000);
    const months = async () =>
      (
        await db.execute(sql`select to_char(month, 'YYYY-MM') as month, earned_tier, held_tier
          from merchant_tier_months where customer_id = ${shop}`)
      ).rows;
    const job = new MerchantLevelJob(pgBoss, db);
    expect(await job.monthly(nextFirst)).toBeGreaterThanOrEqual(1);
    expect(await job.monthly(nextFirst)).toBeGreaterThanOrEqual(1);
    expect(await months()).toEqual([{ month, earned_tier: 'bronze', held_tier: 'bronze' }]);

    // The month's row keeps the tier held at its end, before the recomputation moves it (PG5).
    const held = await merchant();
    await inRollback(async (tx) => {
      const gold = await goldLevel(tx);
      await tx.execute(sql`update merchant_profiles set level_id = ${gold},
        earned_level_id = ${gold}, level_source = 'earned' where customer_id = ${held}`);
      await new MerchantLevelJob(pgBoss, tx as unknown as Database).monthly(nextFirst);
      const rows = await tx.execute(sql`select earned_tier, held_tier, held_source
        from merchant_tier_months where customer_id = ${held}`);
      expect(rows.rows).toEqual([
        { earned_tier: 'bronze', held_tier: 'gold', held_source: 'earned' },
      ]);
      expect(await changes(tx, held)).toEqual([
        { from_tier: 'gold', to_tier: 'bronze', source: 'earned' },
      ]);
    });

    // A failing merchant does not stop the others; the run then fails naming them.
    const { db: failing, state } = poisoned(0);
    const merchants = await new MerchantLevelJob(pgBoss, db).monthly(nextFirst);
    await expect(new MerchantLevelJob(pgBoss, failing).monthly(nextFirst)).rejects.toThrow(
      'Merchant level schedule failed for 1 merchants',
    );
    expect(state.calls).toBeGreaterThanOrEqual(merchants);
  });

  it('merchants.tier-reminders reminds a merchant near Silver once a month, never a frozen one (PG3)', async () => {
    const [near, far, frozen] = [await merchant(), await merchant(), await merchant()];
    await db.update(customers).set({ frozenAt: new Date() }).where(eq(customers.id, frozen));
    await inRollback(async (tx) => {
      const [list] = (
        await tx.execute<{ id: string }>(
          sql`select id from price_lists where kind = 'wholesale' and archived_at is null limit 1`,
        )
      ).rows;
      await tx.execute(sql`insert into merchant_levels
        (id, tier, name_ar, monthly_threshold_usd_units, price_list_id)
        values (${newId()}, 'silver', ${TIER_NAMES_AR.silver}, 10000000, ${list?.id})`);
      // $8 of purchases this month: $2 short of Silver's $10, within 30% (edge case 11: none at $0).
      for (const shop of [near, frozen]) {
        await postJournal(tx, {
          idempotencyKey: `test:${newId()}`,
          kind: 'adjustment',
          postings: [
            { accountId: await ensureCustomerWallet(tx, shop), amountUnits: 8_000_000 },
            {
              accountId: await ensureSystemAccount(tx, {
                code: 'adjustments:test_funds',
                kind: 'adjustments',
                currency: 'USD',
              }),
              amountUnits: -8_000_000,
            },
          ],
        });
        await postJournal(tx, {
          idempotencyKey: `test:${newId()}`,
          kind: 'purchase',
          postings: [
            { accountId: await ensureCustomerWallet(tx, shop), amountUnits: -8_000_000 },
            {
              accountId: await ensureSystemAccount(tx, {
                code: 'sales_revenue:USD',
                kind: 'sales_revenue',
                currency: 'USD',
              }),
              amountUnits: 8_000_000,
            },
          ],
        });
      }
      const job = new MerchantTierRemindersJob(pgBoss, tx as unknown as Database);
      const now = new Date();
      expect(await job.sendAll(now)).toBeGreaterThanOrEqual(1);
      await job.sendAll(now);
      const told = async (shop: string) =>
        (
          await tx.execute<{ params: Record<string, unknown> }>(
            sql`select params from customer_notifications where customer_id = ${shop}
              and event = 'merchant_tier_reminder'`,
          )
        ).rows;
      expect(await told(near)).toEqual([
        {
          params: {
            kind: 'reach',
            tier: 'silver',
            missingUsdUnits: 2_000_000,
            month: damascusMonth(now),
          },
        },
      ]);
      expect(await told(far)).toEqual([]);
      expect(await told(frozen)).toEqual([]);
    });
  });

  it('names the reach and keep reminders and what a tier grants (PG3, ID4)', () => {
    const store = 'https://digital.example';
    const reach = renderEmail(
      'customer_merchant_tier_reminder',
      { kind: 'reach', tier: 'gold', missingUsdUnits: 280_000_000, month: '2030-01' },
      store,
    );
    expect(reach.text).toContain('ينقصك');
    expect(reach.text).toContain('$280.00');
    expect(reach.text).toContain('الفئة الذهبية');
    expect(reach.text).toContain('https://digital.example/merchant/tier');
    const keep = renderEmail(
      'customer_merchant_tier_reminder',
      { kind: 'keep', tier: 'silver', missingUsdUnits: 50_000_000, month: '2030-01' },
      store,
    );
    expect(keep.text).toContain('لتحتفظ');
    expect(
      renderPush('merchant_tier_reminder', {
        kind: 'reach',
        tier: 'gold',
        missingUsdUnits: 280_000_000,
        month: '2030-01',
      }),
    ).toMatchObject({ url: '/merchant/tier' });
    const changed = renderEmail(
      'customer_merchant_level_changed',
      {
        levelNameAr: 'ذهبي',
        priceKind: 'wholesale',
        direction: 'up',
        tier: 'gold',
        privileges: TIER_SETTINGS_DEFAULTS.gold,
      },
      store,
    );
    expect(changed.text).toContain('ما تمنحك إياه فئتك');
    expect(changed.text).toMatch(/100\D{0,3} كوداً في الطلب الواحد/);
    expect(changed.text).not.toContain('الطلب الجماعي');
    expect(changed.text).toContain('شعار محلك بحجم أكبر');
  });

  it('names the tier in the Telegram messages and the summary line (TR8, MG5, AD6)', () => {
    const customerId = newId();
    const changed = renderTelegramMessage(
      'merchant_tier_changed',
      {
        customerId,
        tradeName: 'محل النور',
        from: 'silver',
        to: 'gold',
        source: 'earned',
        thisMonthUsdUnits: 1_250_000_000,
        previousMonthUsdUnits: 400_000_000,
      },
      LINKS,
    ).text;
    expect(changed).toContain('محل النور: تاجر فضي ← تاجر ذهبي (بحسب المشتريات)');
    expect(changed).toContain('$1,250.00');
    expect(changed).toContain(`https://admin.example/customers/${customerId}`);
    const ending = renderTelegramMessage(
      'merchant_tier_grant_ending',
      {
        customerId,
        tradeName: 'محل النور',
        tier: 'diamond',
        endsAt: '2030-01-10T21:59:59.000Z',
        earnedTier: 'bronze',
      },
      LINKS,
    ).text;
    expect(ending).toContain('تنتهي فئة تاجر ماسي الممنوحة لـ محل النور');
    expect(ending).toContain('فئة تاجر برونزي');
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

  it('names the tier when the notification carries it (S23 TR6)', () => {
    const up = renderEmail(
      'customer_merchant_level_changed',
      { levelNameAr: 'ذهبي', priceKind: 'wholesale', direction: 'up', tier: 'gold' },
      store,
    );
    expect(up.subject).toContain('تاجر ذهبي');
    expect(up.text).toContain('ارتقت فئة حسابك إلى');
    expect(up.text).toContain('أسعار الجملة');
    const down = renderEmail(
      'customer_merchant_level_changed',
      { levelNameAr: null, priceKind: 'wholesale', direction: 'down', tier: 'bronze' },
      store,
    );
    expect(down.text).toContain('أصبحت فئة حسابك');
    expect(down.text).toContain('تاجر برونزي');
    expect(
      renderPush('merchant_level_changed', {
        levelNameAr: null,
        priceKind: 'wholesale',
        direction: 'down',
        tier: 'bronze',
      }).body,
    ).toBe('فئة حسابك الآن: تاجر برونزي');
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

describe('operations jobs (S23 OP6, OP7, OP8)', () => {
  const env = { SUPPLIER_FAKE_ENABLED: true } as Env;
  const sender = { send: async () => newId() };
  /** A new Bronze settings row in the transaction, with `changes` (TS1: the newest is in force). */
  const bronzeWith = async (tx: Transaction, changes: Record<string, unknown>) => {
    const [bronze] = await tx
      .select()
      .from(merchantTierSettings)
      .where(eq(merchantTierSettings.tier, 'bronze'))
      .orderBy(desc(merchantTierSettings.createdAt), desc(merchantTierSettings.id))
      .limit(1);
    if (!bronze) throw new Error('No Bronze settings');
    const { id: _id, createdAt: _at, ...values } = bronze;
    await tx.insert(merchantTierSettings).values({ ...values, id: newId(), ...changes });
  };

  it('tells the admin of a ticket past its tier promise once per waiting period (OP6)', async () => {
    const shop = await merchant();
    await inRollback(async (tx) => {
      await bronzeWith(tx, { supportReplyMinutes: 15 });
      const ticket = newId();
      await tx.insert(supportTickets).values({
        id: ticket,
        number: `VT-${newId()
          .slice(-6)
          .toUpperCase()
          .replace(/[^2-9A-HJKMNP-Z]/g, '2')}`,
        customerId: shop,
        category: 'account',
        subject: 'طلب عاجل',
        status: 'open',
        openedBy: 'customer',
        lastCustomerMessageAt: sql`now() - interval '20 minutes'`,
      });
      const now = new Date();
      const due = (await overdueTickets(tx, now)).find((row) => row.ticketId === ticket);
      expect(due).toMatchObject({ tier: 'bronze', replyMinutes: 15, tradeName: 'محل النور' });
      expect(await tellTicketOverdue(tx, sender, due as OverdueTicket, now)).toBe(true);
      expect(await tellTicketOverdue(tx, sender, due as OverdueTicket, now)).toBe(false);
      const [row] = (
        await tx.execute<{ params: { waitingMinutes: number } }>(
          sql`select params from telegram_messages where kind = 'ticket_overdue'
            and params->>'ticketId' = ${ticket}`,
        )
      ).rows;
      expect(row?.params.waitingMinutes).toBeGreaterThanOrEqual(20);
      // A ticket answered (no longer open), or within the promise, is not overdue.
      await tx.execute(sql`update support_tickets set last_customer_message_at = now()
        where id = ${ticket}`);
      expect((await overdueTickets(tx, now)).some((item) => item.ticketId === ticket)).toBe(false);
    });
    const text = renderTelegramMessage(
      'ticket_overdue',
      {
        ticketId: newId(),
        number: 'VT-K7Q2MA',
        subject: 'طلب عاجل',
        tier: 'gold',
        tradeName: 'محل النور',
        replyMinutes: 180,
        waitingMinutes: 200,
      },
      LINKS,
    ).text;
    expect(text).toContain('تاجر ذهبي');
    expect(text).toContain('200 دقيقة');
  });

  it('counts the windows that ended since the last run, and refreshes the store (OP7)', async () => {
    const productId = await product();
    await inRollback(async (tx) => {
      const now = new Date();
      await tx.execute(sql`update catalog_products set early_access_until = now() - interval '1 minute'
        where id = ${productId}`);
      const span = new Date(now.getTime() - EARLY_ACCESS_END_LOOKBACK_MS);
      expect(await earlyAccessEndedBetween(tx, span, now)).toBeGreaterThanOrEqual(1);
      await tx.execute(sql`update catalog_products set early_access_until = now() + interval '1 hour'
        where id = ${productId}`);
      const before = await earlyAccessEndedBetween(tx, span, now);
      await tx.execute(sql`update catalog_products set early_access_until = now() - interval '1 hour'
        where id = ${productId}`);
      expect(await earlyAccessEndedBetween(tx, span, now)).toBe(before);
    });
    // A committed end: both runs queue the refresh in the one debounced slot; none without an end.
    const sent: { queue: string; options: { singletonKey?: string } }[] = [];
    const counting = {
      boss: {
        send: async (queue: string, _data: unknown, options: { singletonKey?: string }) => {
          sent.push({ queue, options });
          return null;
        },
      },
    } as unknown as PgBossService;
    const refreshing = new CatalogEarlyAccessEndJob(counting, db);
    await db.execute(sql`update catalog_products set early_access_until = now() - interval '1 minute'
      where id = ${productId}`);
    try {
      expect(await refreshing.run(new Date())).toBeGreaterThanOrEqual(1);
      expect(await refreshing.run(new Date())).toBeGreaterThanOrEqual(1);
      expect(sent).toHaveLength(2);
      expect(sent.every((job) => job.queue === QUEUES.storeRevalidate)).toBe(true);
      expect(sent.every((job) => job.options.singletonKey === 'catalog')).toBe(true);
      expect(await refreshing.run(new Date(Date.UTC(2035, 0, 1)))).toBe(0);
      expect(sent).toHaveLength(2);
    } finally {
      await db.execute(
        sql`update catalog_products set early_access_until = null where id = ${productId}`,
      );
    }
  });

  it('compares faster-alert tiers every quarter hour and the others hourly (OP8)', async () => {
    const job = new MerchantWatchAlertsJob(pgBoss, db, env);
    const shop = await merchant();
    await db.execute(sql`insert into merchant_watches (id, customer_id, product_id)
      values (${newId()}, ${shop}, ${await product()})`);
    const at = (minute: number) => new Date(Date.UTC(2030, 0, 2, 10, minute));
    expect((await job.dueMerchants(at(5))).due).toContain(shop);
    expect((await job.dueMerchants(at(20))).due).not.toContain(shop);
    // Bronze with faster alerts: compared at :20 too.
    const [bronze] = await db
      .select()
      .from(merchantTierSettings)
      .where(eq(merchantTierSettings.tier, 'bronze'))
      .orderBy(desc(merchantTierSettings.createdAt), desc(merchantTierSettings.id))
      .limit(1);
    if (!bronze) throw new Error('No Bronze settings');
    const { id: _id, createdAt: _at, ...values } = bronze;
    await db.insert(merchantTierSettings).values({ ...values, id: newId(), fastAlerts: true });
    try {
      const quarter = await job.dueMerchants(at(20));
      expect(quarter.due).toContain(shop);
      expect(quarter.fast.has(shop)).toBe(true);
    } finally {
      await db.insert(merchantTierSettings).values({ ...values, id: newId() });
    }
  });

  it('names the early access in the push, never a price (OP5)', () => {
    expect(
      renderPush('merchant_early_access', {
        gameSlug: 'pubg-mobile',
        gameNameAr: 'ببجي موبايل',
        productId: null,
        productNameAr: null,
        until: '2030-01-02T10:00:00.000Z',
      }),
    ).toMatchObject({ body: expect.stringContaining('ببجي موبايل'), url: '/games/pubg-mobile' });
  });
});
