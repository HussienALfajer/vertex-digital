import shop from '../src/features/shop/messages.ar.json' with { type: 'json' };
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * A merchant's shop under /s/<slug> (S26 PR 3): its own frame, its catalog at the selling prices
 * (served to the store's server by e2e/catalog-server.mjs), and the shop customer's pages against
 * the mocked shop API. Amounts in micro-dollars (ADR 0003).
 */

const USD = 1_000_000;
const SLUG = 'abu-omar';
const API = `/api/shops/${SLUG}`;
const PROFILE = {
  id: '0199f100-0000-7000-8000-000000000001',
  name: 'باسل حمدان',
  email: 'basel@example.com',
  phone: '+963933100301',
  frozen: false,
  createdAt: '2026-11-10T09:00:00.000Z',
};
const RETURN = {
  id: '0199f100-0000-7000-8000-000000000e01',
  amountUsdUnits: 2 * USD,
  status: 'pending',
  expiresAt: '2026-11-12T09:00:00.000Z',
  decidedAt: null,
  createdAt: '2026-11-11T09:00:00.000Z',
};

/** What every shop page asks for: the visit counter and the shop's icon. */
function shopPages(api: MockApi): MockApi {
  api.on(`POST ${API}/visits`, 204, {});
  api.image(`GET ${API}/icon`);
  return api.on(`GET ${API}/me`, 401, { statusCode: 401, code: 'UNAUTHORIZED' });
}

function signedIn(api: MockApi, balance = 20 * USD, pendingReturn: unknown = null): MockApi {
  return shopPages(api)
    .on(`GET ${API}/notifications/unread-count`, 200, { unreadCount: 0 })
    .on(`GET ${API}/me`, 200, PROFILE)
    .on(`GET ${API}/wallet`, 200, { balanceUsdUnits: balance, rate: '14000', pendingReturn });
}

/** PUBG's 60 UC: $0.99 at the store, the merchant's +10% is $1.09, 15,260 SYP at 14,000. */
const PACK_60 = '0199d000-0000-7000-8000-00000000000b';

const ORDER = {
  id: '0199f100-0000-7000-8000-0000000000a1',
  number: 'VD-1001',
  stage: 'delivered',
  product: { id: PACK_60, nameAr: '60 UC', kind: 'direct' },
  game: {
    id: '0199d000-0000-7000-8000-000000000001',
    slug: 'pubg-mobile',
    nameAr: 'ببجي موبايل',
    cover: null,
  },
  fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب (ID)', value: '51234567' }],
  quantity: 1,
  deliveredQuantity: 1,
  refundedQuantity: 0,
  refundReason: null,
  recipient: null,
  timeline: [
    { step: 'paid', at: '2026-11-11T10:00:00.000Z' },
    { step: 'sent', at: '2026-11-11T10:00:02.000Z' },
    { step: 'delivered', at: '2026-11-11T10:00:40.000Z' },
  ],
  codes: [],
  playerName: 'BaselPro',
  playerRegion: null,
  deliveryStats: null,
  expectedWithinMinutes: null,
  verificationCode: 'Vf0123456789abcdefghij',
  help: {
    status: 'delivered',
    paidAt: '2026-11-11T10:00:00.000Z',
    finishedAt: '2026-11-11T10:00:40.000Z',
    openTicketId: null,
  },
  createdAt: '2026-11-11T10:00:00.000Z',
  unitSellUsdUnits: 1_090_000,
  totalSellUsdUnits: 1_090_000,
  totalSellSypUnits: 1_526_000,
  refundedUsdUnits: 0,
  compensatedUsdUnits: 0,
};

const theme = async (page: Parameters<typeof screenshot>[0], name: 'dark' | 'light') => {
  if (name === 'light') {
    await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
  }
};

test('a visitor sees the shop in its own frame, with no link to the store', async ({
  page,
  api,
}) => {
  shopPages(api);
  await page.goto(`/s/${SLUG}`);
  await expect(page.getByRole('link', { name: 'متجر أبو عمر' })).toBeVisible();
  await expect(page.getByText(/الشحن متوفر من 9 صباحاً/)).toBeVisible();
  await expect(page.getByRole('heading', { name: shop.home.pinned })).toBeVisible();
  await expect(page.getByText(shop.footer.poweredBy)).toBeVisible();
  // Decision 12: no link out to the store, and SP4: never indexed.
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  expect(hrefs.filter((href) => !href.startsWith(`/s/${SLUG}`))).toEqual([]);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    `/s/${SLUG}/manifest.webmanifest`,
  );
  // SP1: the installed app starts on the shop's home, inside its scope.
  const manifest = await (await page.request.get(`/s/${SLUG}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ scope: `/s/${SLUG}`, start_url: `/s/${SLUG}` });
  expect(new URL(page.url()).pathname.startsWith(manifest.scope)).toBe(true);
  // ADR 0040: a shop page never reads the store's session.
  expect(api.count('GET /api/auth/get-session')).toBe(0);
  // The shop's search lists its own games only.
  await page.getByRole('searchbox').fill('فري');
  await expect(page.getByRole('search').getByRole('link', { name: /فري فاير/ })).toBeVisible();
  await page.getByRole('searchbox').fill('شام كاش');
  await expect(page.getByText(shop.home.searchEmpty)).toBeVisible();
  // A pack asks the visitor to sign in, back to the pack.
  await page.goto(`/s/${SLUG}/games/pubg-mobile?pack=${PACK_60}`);
  await expect(page.getByText('15,260 ل.س').first()).toBeVisible();
  await page.getByRole('link', { name: shop.buy.signIn }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${SLUG}/sign-in\\?next=`));
});

test('an old slug moves to the shop, and an unknown shop is a 404 without the store', async ({
  page,
  api,
}) => {
  shopPages(api);
  await page.goto('/s/old-omar');
  await expect(page).toHaveURL(`/s/${SLUG}`);
  // Streamed: the page answers its 404 view with `noindex`, as the store's other dynamic pages.
  await page.goto('/s/no-such-shop');
  await expect(page.getByRole('heading', { name: shop.notFound.title })).toBeVisible();
  await expect(page.getByRole('link', { name: ar.notFound.back })).toHaveCount(0);
  // A mistyped address inside a known shop stays in the shop's frame.
  await page.goto(`/s/${SLUG}/no-such-page`);
  await expect(page.getByRole('heading', { name: shop.notFound.title })).toBeVisible();
  await expect(page.getByRole('link', { name: 'متجر أبو عمر' })).toBeVisible();
  await expect(page.getByRole('link', { name: ar.notFound.back })).toHaveCount(0);
});

test('the notification center lists the shop’s events and marks them read (PR9)', async ({
  page,
  api,
}) => {
  signedIn(api).on(`GET ${API}/notifications/unread-count`, 200, { unreadCount: 2 });
  api.on(`GET ${API}/notifications`, 200, {
    items: [
      {
        id: '0199f100-0000-7000-8000-0000000000b2',
        readAt: null,
        createdAt: '2026-11-11T10:01:00.000Z',
        event: 'order_delivered',
        params: { orderId: ORDER.id, orderNumber: 'VD-1001', productNameAr: '60 UC', quantity: 1 },
      },
      {
        id: '0199f100-0000-7000-8000-0000000000b1',
        readAt: null,
        createdAt: '2026-11-11T09:00:00.000Z',
        event: 'transfer_received',
        params: { amountUsdUnits: 20 * USD },
      },
    ],
    nextCursor: null,
    unreadCount: 2,
  });
  api.on(`POST ${API}/notifications/read`, 200, { unreadCount: 0 });
  await page.goto(`/s/${SLUG}`);
  await page.getByRole('link', { name: /الإشعارات \(2/ }).click();
  await expect(page.getByRole('link', { name: /تم تسليم طلبك/ })).toHaveAttribute(
    'href',
    `/s/${SLUG}/orders/VD-1001`,
  );
  await expect(page.getByText(/شحن المتجر رصيدك/)).toBeVisible();
  await expect
    .poll(() => api.last(`POST ${API}/notifications/read`)?.body)
    .toEqual({
      upToId: '0199f100-0000-7000-8000-0000000000b2',
    });
});

test('a suspended shop says so and sells nothing (SH6)', async ({ page, api }) => {
  api.on('POST /api/shops/quiet-shop/visits', 204, {});
  api.image('GET /api/shops/quiet-shop/icon');
  api.on('GET /api/shops/quiet-shop/me', 200, PROFILE);
  api.on('GET /api/shops/quiet-shop/notifications/unread-count', 200, { unreadCount: 0 });
  api.on('GET /api/shops/quiet-shop/wallet', 200, {
    balanceUsdUnits: 5 * USD,
    rate: '14000',
    pendingReturn: null,
  });
  await page.goto(`/s/quiet-shop/games/pubg-mobile?pack=${PACK_60}`);
  await expect(page.getByText(shop.status.suspended).first()).toBeVisible();
  await expect(page.getByText(shop.buy.suspended)).toBeVisible();
});

test('the customer signs in and buys a pack at the selling price (PR5)', async ({ page, api }) => {
  shopPages(api);
  api.on(`POST ${API}/auth/sign-in/email`, 200, { redirect: false, token: 't' });
  await page.goto(
    `/s/${SLUG}/sign-in?next=${encodeURIComponent(`/s/${SLUG}/games/pubg-mobile?pack=${PACK_60}`)}`,
  );
  await page.getByLabel(ar.fields.email).fill('basel@example.com');
  await page.getByLabel(ar.fields.password, { exact: true }).fill('a-long-password');
  signedIn(api);
  await page.getByRole('button', { name: shop.auth.signInSubmit }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${SLUG}/games/pubg-mobile`));
  // The header's balance, SYP first at the shop's rate (behind the phone's open buy sheet).
  await expect(page.locator('header').getByText('280,000 ل.س')).toBeAttached();

  api.on(`POST ${API}/player-checks`, 200, {
    result: 'valid',
    playerName: 'BaselPro',
    region: null,
  });
  api.on(`POST ${API}/orders`, 201, ORDER);
  api.on(`GET ${API}/orders/VD-1001`, 200, ORDER);
  await page.getByLabel(/معرّف اللاعب/).fill('51234567');
  await expect(page.getByText('BaselPro')).toBeVisible();
  await page.getByRole('button', { name: shop.buy.continue }).click();
  const slider = page.getByRole('slider');
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page).toHaveURL(`/s/${SLUG}/orders/VD-1001`);
  const sent = api.last(`POST ${API}/orders`);
  expect(sent?.body).toEqual({
    productId: PACK_60,
    quantity: 1,
    fields: { player_id: '51234567' },
    expectedUnitSellUsdUnits: 1_090_000,
    confirmPlayer: false,
  });
  expect(sent?.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByText(ar.orders.stages.delivered).first()).toBeVisible();
});

test('a short balance asks the shop to top it up (S26 screens)', async ({ page, api }) => {
  signedIn(api, 0);
  await page.goto(`/s/${SLUG}/games/pubg-mobile?pack=${PACK_60}`);
  await expect(page.getByText(shop.buy.gapTitle)).toBeVisible();
  await expect(page.getByRole('link', { name: shop.buy.gapWhatsapp })).toHaveAttribute(
    'href',
    'https://wa.me/963944123456',
  );
});

test('the customer confirms the merchant’s return request (WL5)', async ({ page, api }) => {
  signedIn(api, 20 * USD, RETURN);
  api.on(`GET ${API}/wallet/entries`, 200, {
    items: [
      {
        id: '0199f100-0000-7000-8000-0000000000e1',
        kind: 'transfer_in',
        amountUnits: 20 * USD,
        balanceAfterUnits: 20 * USD,
        orderId: null,
        createdAt: '2026-11-11T09:00:00.000Z',
      },
    ],
    nextCursor: null,
  });
  api.on(`POST ${API}/return-requests/${RETURN.id}/confirm`, 201, {
    ...RETURN,
    status: 'confirmed',
  });
  await page.goto(`/s/${SLUG}/wallet`);
  await expect(page.getByRole('heading', { name: shop.return.title })).toBeVisible();
  await expect(page.getByText(shop.wallet.kinds.transfer_in)).toBeVisible();
  api.on(`GET ${API}/wallet`, 200, {
    balanceUsdUnits: 18 * USD,
    rate: '14000',
    pendingReturn: null,
  });
  const slider = page.getByRole('slider');
  await slider.focus();
  await page.keyboard.press('End');
  await expect(page.getByText(shop.return.confirmed)).toBeVisible();
  expect(
    api.last(`POST ${API}/return-requests/${RETURN.id}/confirm`)?.headers['idempotency-key'],
  ).toBeTruthy();
});

test('a visitor signs up, then enters the email code (CA2)', async ({ page, api }) => {
  shopPages(api);
  api.on(`POST ${API}/auth/sign-up`, 200, { status: 'code_sent' });
  api.on(`POST ${API}/auth/email-otp/verify-email`, 200, { status: true });
  await page.goto(`/s/${SLUG}/sign-up`);
  await page.getByLabel(ar.fields.name).fill('هبة يوسف');
  await page.getByLabel(ar.fields.email).fill('heba@example.com');
  await page.getByLabel(ar.fields.password, { exact: true }).fill('a-long-password-1');
  await page.getByLabel(ar.fields.phone).fill('0944100302');
  await page.getByRole('button', { name: shop.auth.signUpSubmit }).click();
  await expect(page.getByText(shop.auth.acceptTermsMissing)).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: shop.auth.signUpSubmit }).click();
  await expect(page).toHaveURL(`/s/${SLUG}/verify`);
  expect(api.last(`POST ${API}/auth/sign-up`)?.body).toMatchObject({
    email: 'heba@example.com',
    phone: '+963944100302',
    acceptTerms: true,
  });
  await page
    .getByRole('textbox', { name: ar.fields.code, exact: true })
    .filter({ visible: true })
    .fill('123456');
  signedIn(api);
  await page.getByRole('button', { name: shop.auth.verifySubmit }).click();
  await expect(page).toHaveURL(`/s/${SLUG}`);
  expect(api.last(`POST ${API}/auth/email-otp/verify-email`)?.body).toEqual({
    email: 'heba@example.com',
    otp: '123456',
    password: 'a-long-password-1',
  });
});

test('signed out, a customer page goes to the shop’s sign-in and back', async ({ page, api }) => {
  shopPages(api);
  await page.goto(`/s/${SLUG}/orders`);
  await expect(page).toHaveURL(`/s/${SLUG}/sign-in?next=%2Fs%2F${SLUG}%2Forders`);
});

// RTL screenshots of the shop's home, game, wallet and order pages, dark and light.
for (const name of ['dark', 'light'] as const) {
  test(`shop screenshots, ${name} theme`, async ({ page, api }, testInfo) => {
    test.setTimeout(90_000);
    await theme(page, name);
    signedIn(api, 20 * USD, RETURN);
    api.on(`GET ${API}/wallet/entries`, 200, { items: [], nextCursor: null });
    api.on(`GET ${API}/orders/VD-1001`, 200, ORDER);
    api.on(`GET ${API}/orders`, 200, {
      items: [
        {
          id: ORDER.id,
          number: ORDER.number,
          stage: 'delivered',
          productNameAr: '60 UC',
          productKind: 'direct',
          amountStep: null,
          amountUnitAr: null,
          game: ORDER.game,
          quantity: 1,
          createdAt: ORDER.createdAt,
          totalSellUsdUnits: ORDER.totalSellUsdUnits,
          totalSellSypUnits: ORDER.totalSellSypUnits,
        },
      ],
      nextCursor: null,
    });
    await page.goto(`/s/${SLUG}`);
    await expect(page.getByRole('heading', { name: shop.return.title })).toBeVisible();
    await screenshot(page, testInfo, `shop-home-${name}`);
    await page.goto(`/s/${SLUG}/games/pubg-mobile?pack=${PACK_60}`);
    await expect(page.getByRole('button', { name: shop.buy.continue })).toBeVisible();
    await screenshot(page, testInfo, `shop-game-${name}`);
    await page.goto(`/s/${SLUG}/wallet`);
    await expect(page.getByText(shop.wallet.noEntries)).toBeVisible();
    await screenshot(page, testInfo, `shop-wallet-${name}`);
    await page.goto(`/s/${SLUG}/orders`);
    await expect(page.getByText('VD-1001')).toBeVisible();
    await screenshot(page, testInfo, `shop-orders-${name}`);
    await page.goto(`/s/${SLUG}/orders/VD-1001`);
    await expect(page.getByText('BaselPro')).toBeVisible();
    await expect(page.locator('svg[role="img"]')).toBeVisible();
    await screenshot(page, testInfo, `shop-order-${name}`);
  });
}
