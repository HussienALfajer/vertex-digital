import { EMAIL_PARAMS, NOTIFICATION_PARAMS } from '@vertex-digital/contracts';
import {
  createDatabase,
  customers,
  merchantShops,
  newId,
  shopCustomers,
  shopCustomerVerifications,
  shopReturnRequests,
} from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { PurgeExpiredJob } from '../src/jobs/auth/purge-expired.job.js';
import { renderEmail } from '../src/jobs/email/email-templates.js';
import { renderPush } from '../src/jobs/push/push-texts.js';
import { ReturnRequestsExpireJob } from '../src/jobs/shops/return-requests-expire.job.js';
import { renderTelegramMessage } from '../src/telegram/messages.js';

/*
 * Merchant shops in the worker (S26 PR 1): the return requests' expiry (WL5) against the test
 * database (committed rows: the job opens a transaction per request, as in production), the shop
 * realm's purge, and the shop emails, pushes and Telegram notices.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
const pgBoss = { boss: { send: async () => null } } as unknown as PgBossService;
const LINKS = { admin: 'https://admin.example', store: 'https://store.example' };
const STORE = 'https://digital.example';

afterAll(() => connection.close());

async function shopCustomer() {
  const merchantId = newId();
  await db.insert(customers).values({
    id: merchantId,
    name: 'Merchant',
    email: `${merchantId}@test.vertex-digital.local`,
    phone: '+963900000000',
    accountType: 'merchant',
  });
  const [shop] = await db
    .insert(merchantShops)
    .values({
      merchantId,
      slug: `w${newId().slice(-12)}`,
      displayName: 'متجر النور',
      brandColor: '#1f7a6c',
    })
    .returning({ id: merchantShops.id });
  const shopId = shop?.id as string;
  await db
    .update(merchantShops)
    .set({ status: 'active', decidedAt: sql`now()` })
    .where(eq(merchantShops.id, shopId));
  const id = newId();
  await db.insert(shopCustomers).values({
    id,
    shopId,
    name: 'سامي',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000001',
    emailVerified: true,
    createdBy: 'merchant',
  });
  return { merchantId, shopId, id };
}

describe('shop.return-requests-expire (WL5)', () => {
  it('expires pending requests past their 24 hours, once, and tells the merchant', async () => {
    const { merchantId, shopId, id } = await shopCustomer();
    const [due] = await db
      .insert(shopReturnRequests)
      .values({
        shopId,
        shopCustomerId: id,
        amountUsdUnits: 1_000_000,
        expiresAt: new Date(Date.now() - 60_000),
        idempotencyKey: newId(),
      })
      .returning({ id: shopReturnRequests.id });
    const job = new ReturnRequestsExpireJob(pgBoss, db);
    expect(await job.run()).toContain(due?.id);
    expect(await job.run()).not.toContain(due?.id);
    const [row] = await db
      .select({ status: shopReturnRequests.status })
      .from(shopReturnRequests)
      .where(eq(shopReturnRequests.id, due?.id as string));
    expect(row?.status).toBe('expired');
    const notices = await db.execute(
      sql`select params->>'status' as status from customer_notifications
        where customer_id = ${merchantId} and event = 'merchant_shop_return_ended'`,
    );
    expect(notices.rows).toEqual([{ status: 'expired' }]);
  });
});

describe('auth.purge-expired for the shop realm', () => {
  it('deletes expired shop codes and keeps live ones', async () => {
    const expired = `email-verification:${newId()}:a@test.vertex-digital.local`;
    const live = `email-verification:${newId()}:b@test.vertex-digital.local`;
    await db.insert(shopCustomerVerifications).values([
      { identifier: expired, value: 'x:0', expiresAt: new Date(Date.now() - 1000) },
      { identifier: live, value: 'x:0', expiresAt: new Date(Date.now() + 600_000) },
    ]);
    await new PurgeExpiredJob(pgBoss, db).purge();
    const rows = await db
      .select({ identifier: shopCustomerVerifications.identifier })
      .from(shopCustomerVerifications)
      .where(sql`${shopCustomerVerifications.identifier} in (${expired}, ${live})`);
    expect(rows.map((row) => row.identifier)).toEqual([live]);
  });
});

describe('shop emails, pushes and Telegram notices', () => {
  const shop = { shopName: 'متجر النور', slug: 'al-noor' };
  const at = '2026-11-11T10:00:00.000Z';

  it('sends each shop email in the shop name, with its link in the shop', () => {
    const cases = [
      renderEmail(
        'shop_customer_invitation',
        { ...shop, token: 'tok-123456789012345678901', expiresAt: at },
        STORE,
      ),
      renderEmail('shop_customer_verify_email', { ...shop, code: '123456' }, STORE),
      renderEmail('shop_customer_reset_password', { ...shop, code: '654321' }, STORE),
      renderEmail(
        'shop_customer_transfer_received',
        { ...shop, amountUsdUnits: 5_000_000, at },
        STORE,
      ),
      renderEmail(
        'shop_customer_return_requested',
        { ...shop, amountUsdUnits: 5_000_000, expiresAt: at },
        STORE,
      ),
      renderEmail('shop_customer_return_done', { ...shop, amountUsdUnits: 5_000_000, at }, STORE),
      renderEmail(
        'shop_customer_settled',
        { ...shop, amountUsdUnits: 5_000_000, to: 'cash_refund', at },
        STORE,
      ),
    ];
    for (const email of cases) {
      expect(email.fromName).toBe('متجر النور عبر VERTEX DIGITAL');
      expect(email.text).toContain('متجر النور');
    }
    expect(cases[0]?.text).toContain(`${STORE}/s/al-noor/invite/tok-123456789012345678901`);
    expect(cases[1]?.text).toContain('123456');
    expect(cases[3]?.text).toContain(`${STORE}/s/al-noor/wallet`);
    expect(
      EMAIL_PARAMS.shop_customer_settled.safeParse({ ...shop, amountUsdUnits: 1, to: 'x', at })
        .success,
    ).toBe(false);
  });

  it("emails the merchant each transfer, in Vertex's name", () => {
    const email = renderEmail(
      'customer_merchant_shop_transfer',
      { customerName: 'سامي', amountUsdUnits: 25_000_000, at },
      STORE,
    );
    expect(email.fromName).toBeUndefined();
    expect(email.text).toContain('سامي');
    expect(email.text).toContain(`${STORE}/merchant/shop/customers`);
  });

  it('pushes the shop states and return answers without names or amounts (PT2)', () => {
    const changed = renderPush(
      'merchant_shop_changed',
      NOTIFICATION_PARAMS.merchant_shop_changed.parse({
        status: 'active',
        resumed: true,
        reason: null,
      }),
    );
    expect(changed.body).toBe('عاد متجرك إلى العمل');
    const ended = renderPush('merchant_shop_return_ended', {
      shopCustomerId: newId(),
      customerName: 'سامي',
      amountUsdUnits: 25_000_000,
      status: 'confirmed',
    });
    expect(ended.body).not.toContain('سامي');
    expect(ended.body).not.toContain('25');
  });

  it('tells the admin of a shop request and of a closed shop with balances', () => {
    const shopId = newId();
    const requested = renderTelegramMessage(
      'shop_requested',
      { shopId, slug: 'al-noor', waiting: 2 },
      LINKS,
    );
    expect(requested.text).toContain('/s/al-noor');
    expect(requested.text).toContain(`${LINKS.admin}/shops/${shopId}`);
    const closed = renderTelegramMessage(
      'shop_closed_with_balance',
      { shopId, tradeName: 'محل النور', customers: 3, totalUsdUnits: 45_000_000 },
      LINKS,
    );
    expect(closed.text).toContain('محل النور');
    expect(closed.text).toContain('$45.00');
  });
});
