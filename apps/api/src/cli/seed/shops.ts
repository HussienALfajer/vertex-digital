import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { CURRENCY_SCALE, SHOP_BRAND_COLORS } from '@vertex-digital/contracts';
import type { Database } from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { ContentPagesService } from '../../modules/content/index.js';
import { MerchantsAdminService, MerchantsService } from '../../modules/merchants/index.js';
import {
  issueInvitation,
  ShopAccountsService,
  ShopAuthService,
  ShopsAdminService,
  ShopsMerchantService,
} from '../../modules/shops/index.js';

const usd = (dollars: number) => dollars * CURRENCY_SCALE.USD;

/** The seeded shop's address: `/s/abu-omar`. */
export const SEED_SHOP_SLUG = 'abu-omar';

/** The shop's customers, created by the merchant; each sets the seed's password. */
const SHOP_CUSTOMERS = [
  {
    name: 'باسل حمدان',
    email: 'basel.hamdan@example.com',
    phone: '+963933100301',
    // 280,000 SYP at the shop's own rate (WL2).
    transfer: { currency: 'syp', amountUnits: 280_000 * 100, expectedUsdUnits: usd(20) },
  },
  {
    name: 'هبة يوسف',
    email: 'heba.yousef@example.com',
    phone: '+963944100302',
    transfer: { currency: 'usd', amountUnits: usd(5), expectedUsdUnits: usd(5) },
  },
] as const;

/**
 * S26: one merchant shop to test by hand (`/s/abu-omar`): Omar granted as a merchant (the
 * merchant terms published and accepted), his shop requested with an own rate and approved with
 * limits, an announcement, two customers created by the merchant who set their password from the
 * invitation, a transfer to each, and a return request waiting for Basel. Every step through the
 * API's services, as the rest of the seed.
 */
export async function seedShop(
  app: INestApplicationContext,
  db: Database,
  input: {
    merchantId: string;
    password: string;
    admin: { adminId: string; meta: RequestMeta };
    step: <T>(name: string, run: () => Promise<T>) => Promise<T | undefined>;
    customers: { email: string; name: string; test: boolean }[];
  },
): Promise<void> {
  const get = <T>(type: new (...args: never[]) => T): T => app.get(type, { strict: false });
  const { merchantId, password, admin, step } = input;
  const meta: RequestMeta = { ipAddress: '10.20.0.40', userAgent: 'db:seed-local' };

  const pages = get(ContentPagesService);
  await step('page merchant_terms', async () => {
    const draft = await pages.draft('merchant_terms');
    const saved = await pages.saveDraft(admin, 'merchant_terms', {
      title: 'شروط التاجر',
      body: '## البيع\nتبيع لزبائنك بأسعارك وتتحمّل خدمتهم.\n\n## المتجر\nرصيد زبائن متجرك أمانة لديك حتى يُصرف أو يُعاد.',
      revision: draft.revision,
    });
    return pages.publish(admin, 'merchant_terms', saved.revision);
  });
  await step('omar granted as a merchant', () =>
    get(MerchantsAdminService).grant(
      merchantId,
      {
        tradeName: 'متجر أبو عمر',
        governorate: 'aleppo',
        city: 'اعزاز',
        reason: 'محل شحن في اعزاز، تجربة المتجر',
      },
      { adminId: admin.adminId, meta: admin.meta },
    ),
  );
  await step('omar accepts the merchant terms', async () => {
    const [version] = await db
      .execute<{ id: string }>(
        sql`SELECT id FROM content_page_versions WHERE page = 'merchant_terms' ORDER BY version DESC LIMIT 1`,
      )
      .then((result) => result.rows);
    if (!version) throw new Error('No merchant terms version');
    return get(MerchantsService).acceptTerms(merchantId, version.id, meta);
  });

  const merchant = get(ShopsMerchantService);
  const requested = await step('shop requested', () =>
    merchant.request(
      merchantId,
      {
        slug: SEED_SHOP_SLUG,
        brandColor: SHOP_BRAND_COLORS[2],
        rateMode: 'own',
        rate: '14000',
        confirmFar: false,
      },
      meta,
    ),
  );
  if (!requested) return;
  await step('shop approved', () =>
    get(ShopsAdminService).approve(
      { id: admin.adminId },
      requested.shop.id,
      {
        limits: {
          customerBalanceCapUsdUnits: usd(200),
          dailyTransferCapUsdUnits: usd(1_000),
          customerLimit: 2_000,
        },
      },
      admin.meta,
    ),
  );
  await step('shop announcement', () =>
    merchant.updateSettings(
      merchantId,
      { announcement: 'أهلاً بكم! الشحن متوفر من 9 صباحاً حتى 11 ليلاً. للاستفسار: 0944123456' },
      meta,
    ),
  );
  const shop = await get(ShopAuthService).shopBySlug(SEED_SHOP_SLUG);
  if (!shop) return;

  // WL4: the merchant's 15-minute password check before the transfers.
  const shopMerchant = { id: merchantId, sessionId: randomUUID() };
  await step('transfer check', () => merchant.confirmForTransfers(shopMerchant, password));
  const accounts = get(ShopAccountsService);
  const ids: Record<string, string> = {};
  for (const customer of SHOP_CUSTOMERS) {
    // CA1: created at the counter; the seed takes a fresh invitation token for the password.
    const created = await step(`shop customer ${customer.email}`, async () => {
      const row = await merchant.createCustomer(
        merchantId,
        { name: customer.name, email: customer.email, phone: customer.phone },
        meta,
      );
      const { token } = await db.transaction((tx) => issueInvitation(tx, row.id));
      await accounts.acceptInvitation(shop, { token, password }, meta);
      return row;
    });
    if (!created) continue;
    ids[customer.email] = created.id;
    input.customers.push({
      email: customer.email,
      name: `${customer.name} (/s/${SEED_SHOP_SLUG})`,
      test: false,
    });
    await step(`transfer to ${customer.email}`, () =>
      merchant.transfer(shopMerchant, created.id, customer.transfer, randomUUID(), meta),
    );
  }
  const basel = ids['basel.hamdan@example.com'];
  if (basel) {
    await step('return request to basel', () =>
      merchant.requestReturn(merchantId, basel, usd(2), randomUUID(), meta),
    );
  }
}
