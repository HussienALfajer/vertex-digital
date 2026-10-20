import { createDatabase, customers, merchantApplications, newId } from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { ExpireApplicationsJob } from '../src/jobs/merchants/expire-applications.job.js';
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
