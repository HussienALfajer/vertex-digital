import { randomBytes } from 'node:crypto';
import { sypDisplayPrice } from '@vertex-digital/contracts';
import {
  catalogCategories,
  catalogGames,
  catalogProducts,
  exchangeRates,
  marginRules,
} from '@vertex-digital/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auditOf, body, PASSWORD, removeAccounts, seedCustomer, totp } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The pricing engine (S06, F10) over HTTP against the test database: rules PR2, PR9, PR10 and the
 * spec's acceptance numbers. The global rule is put back to the seed (Q7) after each change; the
 * catalog rows and rules of this file are removed in `afterAll`.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let customerCookie: string;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const target = { categoryId: '', gameId: '', productId: '', otherProductId: '' };

const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const GLOBAL = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };

async function reauthenticate(cookie = admin.cookie) {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

const setRule = (input: Record<string, unknown>, cookie = admin.cookie) =>
  client.put('/api/admin/pricing/rules', { cookie, body: input });

const preview = (input: Record<string, unknown>) =>
  client.post('/api/admin/pricing/preview', { cookie: admin.cookie, body: input });

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

interface Rule {
  id: string;
  scope: string;
  targetId: string | null;
  targetName: string | null;
  targetArchived: boolean;
  productCount: number;
  percentBp: number;
}

const rules = async () =>
  json<Rule[]>(await client.get('/api/admin/pricing/rules', { cookie: admin.cookie }), 200);

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  customerCookie = await client.signInCustomer(customer.email);
  await reauthenticate();
  const post = (path: string, payload: unknown) =>
    client.post(`/api/admin/catalog${path}`, { cookie: admin.cookie, body: payload });
  const category = await json<{ id: string }>(
    await post('/categories', { slug: `pricing-${run}`, nameAr: `تسعير ${run}` }),
    201,
  );
  target.categoryId = category.id;
  const game = await json<{ id: string }>(
    await post('/games', {
      categoryId: category.id,
      slug: `pubg-${run}`,
      nameAr: `ببجي ${run}`,
      nameEn: 'PUBG Mobile',
    }),
    201,
  );
  target.gameId = game.id;
  const product = await json<{ id: string }>(
    await post(`/games/${game.id}/products`, {
      kind: 'direct',
      nameAr: '60 UC',
      officialPriceUsdUnits: usd(0.99),
    }),
    201,
  );
  target.productId = product.id;
  const other = await json<{ id: string }>(
    await post(`/games/${game.id}/products`, { kind: 'direct', nameAr: '325 UC' }),
    201,
  );
  target.otherProductId = other.id;
});

afterAll(async () => {
  await test.db
    .delete(marginRules)
    .where(
      inArray(marginRules.targetId, [
        target.categoryId,
        target.gameId,
        target.productId,
        target.otherProductId,
      ]),
    );
  await test.db
    .update(marginRules)
    .set(GLOBAL)
    .where(and(eq(marginRules.scope, 'global'), isNull(marginRules.archivedAt)));
  await test.db.delete(catalogProducts).where(eq(catalogProducts.gameId, target.gameId));
  await test.db.delete(catalogGames).where(eq(catalogGames.id, target.gameId));
  await test.db.delete(catalogCategories).where(eq(catalogCategories.id, target.categoryId));
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session and to a customer session', async () => {
    for (const cookie of [undefined, customerCookie]) {
      const options = cookie ? { cookie } : {};
      expect((await client.get('/api/admin/pricing/rules', options)).status).toBe(401);
      expect((await client.put('/api/admin/pricing/rules', { ...options, body: {} })).status).toBe(
        401,
      );
      expect(
        (await client.post('/api/admin/pricing/preview', { ...options, body: {} })).status,
      ).toBe(401);
      expect(
        (
          await client.post(
            '/api/admin/pricing/rules/0199a000-0000-7000-8000-000000000001/archive',
            options,
          )
        ).status,
      ).toBe(401);
    }
  });

  it('needs a re-authentication to set or archive a rule', async () => {
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    expect(await body(await setRule({ scope: 'global', ...GLOBAL }, fresh.cookie))).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    const archived = await client.post(
      '/api/admin/pricing/rules/0199a000-0000-7000-8000-000000000001/archive',
      { cookie: fresh.cookie },
    );
    expect(await body(archived)).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    // `adminWithTotp` replaced the only admin: sign the file's admin in again.
    admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    await reauthenticate();
  });

  it('never caches its answers', async () => {
    const response = await client.get('/api/admin/pricing/rules', { cookie: admin.cookie });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('rules (PR2, PR9)', () => {
  it('lists the seeded global rule with the products it governs', async () => {
    const global = (await rules()).find((rule) => rule.scope === 'global');
    expect(global).toMatchObject({ ...GLOBAL, targetId: null, targetName: null });
    expect(global?.productCount).toBeGreaterThanOrEqual(0);
  });

  it('sets a category rule, then replaces it, auditing before and after', async () => {
    const values = { percentBp: 1200, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.15) };
    const created = await json<Rule>(
      await setRule({ scope: 'category', targetId: target.categoryId, ...values }),
      200,
    );
    expect(created).toMatchObject({
      scope: 'category',
      targetId: target.categoryId,
      targetName: `تسعير ${run}`,
      targetArchived: false,
      productCount: 2,
      ...values,
    });
    const replaced = await json<Rule>(
      await setRule({ scope: 'category', targetId: target.categoryId, ...values, percentBp: 1300 }),
      200,
    );
    expect(replaced).toMatchObject({ id: created.id, percentBp: 1300 });
    // The same values again change nothing and write no entry.
    await json(
      await setRule({ scope: 'category', targetId: target.categoryId, ...values, percentBp: 1300 }),
      200,
    );
    expect(await auditOf(test.db, created.id)).toMatchObject([
      {
        action: 'margin_rule.set',
        details: { scope: 'category', targetId: target.categoryId, before: null, after: values },
      },
      {
        action: 'margin_rule.set',
        details: { before: values, after: { ...values, percentBp: 1300 } },
      },
    ]);
    await json(await setRule({ scope: 'category', targetId: target.categoryId, ...values }), 200);
  });

  it('refuses an unknown or archived target, bad values and a missing target id', async () => {
    const values = { percentBp: 500, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.05) };
    expect(
      await body(
        await setRule({
          scope: 'game',
          targetId: '0199a000-0000-7000-8000-000000000001',
          ...values,
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    // A category id is no game.
    expect(
      await body(await setRule({ scope: 'game', targetId: target.categoryId, ...values })),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await body(await setRule({ scope: 'game', ...values }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(
      await body(await setRule({ scope: 'global', ...values, minMarginUsdUnits: 0 })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await json(
      await client.post(`/api/admin/catalog/products/${target.otherProductId}/archive`, {
        cookie: admin.cookie,
      }),
      200,
    );
    expect(
      await body(await setRule({ scope: 'product', targetId: target.otherProductId, ...values })),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await json(
      await client.post(`/api/admin/catalog/products/${target.otherProductId}/restore`, {
        cookie: admin.cookie,
      }),
      200,
    );
  });

  it('archives a rule back to its parent; the global rule stays (GLOBAL_RULE_REQUIRED)', async () => {
    const rule = await json<Rule>(
      await setRule({
        scope: 'product',
        targetId: target.productId,
        percentBp: 500,
        fixedUsdUnits: 0,
        minMarginUsdUnits: usd(0.05),
      }),
      200,
    );
    const archived = await client.post(`/api/admin/pricing/rules/${rule.id}/archive`, {
      cookie: admin.cookie,
    });
    expect(archived.status).toBe(204);
    expect((await auditOf(test.db, rule.id)).at(-1)).toMatchObject({
      action: 'margin_rule.archived',
      details: { scope: 'product', targetId: target.productId, values: { percentBp: 500 } },
    });
    expect(
      await body(
        await client.post(`/api/admin/pricing/rules/${rule.id}/archive`, { cookie: admin.cookie }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const global = (await rules()).find((candidate) => candidate.scope === 'global') as Rule;
    expect(
      await body(
        await client.post(`/api/admin/pricing/rules/${global.id}/archive`, {
          cookie: admin.cookie,
        }),
      ),
    ).toMatchObject({ status: 409, code: 'GLOBAL_RULE_REQUIRED' });
  });

  it('marks a rule whose target is archived (edge case 3)', async () => {
    const values = { percentBp: 1500, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
    const rule = await json<Rule>(
      await setRule({ scope: 'product', targetId: target.otherProductId, ...values }),
      200,
    );
    await json(
      await client.post(`/api/admin/catalog/products/${target.otherProductId}/archive`, {
        cookie: admin.cookie,
      }),
      200,
    );
    expect((await rules()).find((candidate) => candidate.id === rule.id)).toMatchObject({
      targetArchived: true,
      productCount: 0,
    });
    await json(
      await client.post(`/api/admin/catalog/products/${target.otherProductId}/restore`, {
        cookie: admin.cookie,
      }),
      200,
    );
    expect((await rules()).find((candidate) => candidate.id === rule.id)).toMatchObject({
      targetArchived: false,
      productCount: 1,
    });
    const archived = await client.post(`/api/admin/pricing/rules/${rule.id}/archive`, {
      cookie: admin.cookie,
    });
    expect(archived.status).toBe(204);
  });

  it('leaves one live rule when two sets for one target run in parallel', async () => {
    const values = { fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
    const results = await Promise.all([
      setRule({ scope: 'game', targetId: target.gameId, percentBp: 700, ...values }),
      setRule({ scope: 'game', targetId: target.gameId, percentBp: 800, ...values }),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    const live = await test.db
      .select()
      .from(marginRules)
      .where(and(eq(marginRules.targetId, target.gameId), isNull(marginRules.archivedAt)));
    expect(live).toHaveLength(1);
    expect([700, 800]).toContain(live[0]?.percentBp);
    await test.db.delete(marginRules).where(eq(marginRules.targetId, target.gameId));
  });
});

describe('preview (PR3–PR8, PR10)', () => {
  const sypOf = async (priceUsdUnits: number) => {
    const [rate] = await test.db
      .select()
      .from(exchangeRates)
      .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
      .limit(1);
    return rate
      ? sypDisplayPrice(
          priceUsdUnits,
          rate.sypPerUsd.replace(/\.?0+$/, ''),
          rate.displayStepSypUnits,
        )
      : null;
  };

  it('prices a cost with the global rule (the spec examples), with SYP at the current rate', async () => {
    for (const [cost, price] of [
      [0.89, 0.99],
      [8.5, 9.35],
    ] as const) {
      const result = await json(
        await preview({ target: { scope: 'global' }, costUsdUnits: usd(cost) }),
        200,
      );
      expect(result).toMatchObject({
        rule: GLOBAL,
        ruleScope: 'global',
        priceUsdUnits: usd(price),
        marginUsdUnits: usd(price) - usd(cost),
        officialPriceUsdUnits: null,
        savings: null,
        priceSypUnits: await sypOf(usd(price)),
      });
    }
  });

  it('follows the acceptance steps: category rule, product rule, savings', async () => {
    await json(
      await setRule({
        scope: 'category',
        targetId: target.categoryId,
        percentBp: 1200,
        fixedUsdUnits: 0,
        minMarginUsdUnits: usd(0.15),
      }),
      200,
    );
    const fromCategory = await json(
      await preview({
        target: { scope: 'product', targetId: target.productId },
        costUsdUnits: usd(0.89),
      }),
      200,
    );
    expect(fromCategory).toMatchObject({
      ruleScope: 'category',
      priceUsdUnits: usd(1.04),
      officialPriceUsdUnits: usd(0.99),
      savings: null,
    });
    const productRule = await json<Rule>(
      await setRule({
        scope: 'product',
        targetId: target.productId,
        percentBp: 500,
        fixedUsdUnits: 0,
        minMarginUsdUnits: usd(0.05),
      }),
      200,
    );
    const fromProduct = await json(
      await preview({
        target: { scope: 'product', targetId: target.productId },
        costUsdUnits: usd(0.89),
      }),
      200,
    );
    expect(fromProduct).toMatchObject({
      ruleScope: 'product',
      ruleId: productRule.id,
      priceUsdUnits: usd(0.94),
      savings: { amountUsdUnits: usd(0.05), percent: 5 },
    });
    expect(
      await client.post(`/api/admin/pricing/rules/${productRule.id}/archive`, {
        cookie: admin.cookie,
      }),
    ).toMatchObject({ status: 204 });
    const back = await json(
      await preview({
        target: { scope: 'product', targetId: target.productId },
        costUsdUnits: usd(0.89),
      }),
      200,
    );
    expect(back).toMatchObject({ ruleScope: 'category', priceUsdUnits: usd(1.04) });
  });

  it('previews draft values without writing, and refuses unknown targets and bad costs', async () => {
    const before = await test.db.select().from(marginRules);
    const draft = await json(
      await preview({
        target: { scope: 'game', targetId: target.gameId },
        costUsdUnits: 1,
        values: GLOBAL,
      }),
      200,
    );
    expect(draft).toMatchObject({ ruleScope: null, ruleId: null, priceUsdUnits: usd(0.11) });
    expect(await test.db.select().from(marginRules)).toHaveLength(before.length);
    expect(
      await body(
        await preview({
          target: { scope: 'product', targetId: '0199a000-0000-7000-8000-000000000001' },
          costUsdUnits: 1,
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(
      await body(await preview({ target: { scope: 'global' }, costUsdUnits: usd(10_000) + 1 })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('edits the global rule, which applies everywhere without a closer rule', async () => {
    const changed = { percentBp: 2000, fixedUsdUnits: usd(0.05), minMarginUsdUnits: usd(0.1) };
    await json(await setRule({ scope: 'global', ...changed }), 200);
    const result = await json(
      await preview({ target: { scope: 'global' }, costUsdUnits: usd(1) }),
      200,
    );
    expect(result).toMatchObject({ priceUsdUnits: usd(1.25) });
    await json(await setRule({ scope: 'global', ...GLOBAL }), 200);
  });
});
