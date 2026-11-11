import type {
  MerchantShop,
  MerchantShopTicket,
  ShopCustomerRow,
  ShopStats,
} from '@vertex-digital/contracts';
import area from '../src/features/merchant-shop/messages.ar.json' with { type: 'json' };
import tools from '../src/features/merchant-tools/messages.ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S26 PR 4, "متجري" in the merchant area: the shop's request with the slug check, the colors,
 * a far own rate and the live preview (SH1–SH3, ST1, ST3); an approved shop's link, limits,
 * settings and hidden games (ST5, ST6); the customers with a new customer, a transfer in pounds
 * behind the password check and the balance cap's refusal, and a return request (CA1, WL1–WL5);
 * the shop's orders, a ticket's reply and escalation (TK2–TK4) and the statistics (SP3).
 */

const USD = 1_000_000;
const SHOP_ID = '0199e600-0000-7000-8000-000000000001';
const CUSTOMER = '0199e600-0000-7000-8000-0000000000c1';
const TICKET = '0199e600-0000-7000-8000-0000000000d1';
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

function signedIn(api: MockApi): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: {
        name: 'عمر الحلبي',
        email: 'omar@example.com',
        emailVerified: true,
        accountType: 'merchant',
      },
      session: { token: 'this-device' },
    })
    .on('GET /api/merchant/receipt-settings', 200, {
      tradeName: 'محل أبو عمر',
      showWhatsapp: true,
      whatsapp: '+963933123456',
      logoFileId: null,
      welcomeText: null,
      welcomeAllowed: false,
    })
    .on('GET /api/merchant/games', 200, {
      items: [
        {
          id: '0199e600-0000-7000-8000-0000000000a1',
          slug: 'pubg-mobile',
          nameAr: 'ببجي موبايل',
          categoryId: '0199e600-0000-7000-8000-0000000000e1',
          categoryNameAr: 'ألعاب',
          recentUnits: 4,
        },
      ],
    })
    .on('GET /api/catalog/search-index', 200, { games: [], products: [] })
    .on('GET /api/merchant/shop/hidden-games', 200, { gameIds: [] });
}

const shop = (changes: Partial<MerchantShop> = {}): MerchantShop => ({
  id: SHOP_ID,
  slug: 'abu-omar',
  status: 'active',
  displayName: 'محل أبو عمر',
  brandColor: '#1f7a6c',
  announcement: null,
  rateMode: 'own',
  ownRate: '13000',
  rate: '13000',
  limits: {
    customerBalanceCapUsdUnits: 200 * USD,
    dailyTransferCapUsdUnits: 1_000 * USD,
    customerLimit: 2_000,
  },
  transferredTodayUsdUnits: 150 * USD,
  customerCount: 1,
  rejectReason: null,
  suspendReason: null,
  requestedAt: '2026-11-10T09:00:00.000Z',
  decidedAt: '2026-11-10T10:00:00.000Z',
  requestAgainAt: null,
  ...changes,
});

const customer = (changes: Partial<ShopCustomerRow> = {}): ShopCustomerRow => ({
  id: CUSTOMER,
  name: 'سامي علي',
  email: 'sami@example.com',
  phone: '+963944123456',
  state: 'active',
  origin: 'merchant',
  balanceUsdUnits: 20 * USD,
  pendingReturn: null,
  createdAt: '2026-11-10T11:00:00.000Z',
  ...changes,
});

const ticket = (changes: Partial<MerchantShopTicket> = {}): MerchantShopTicket => ({
  id: TICKET,
  number: 'VT-SHOP01',
  category: 'order',
  order: { id: '0199e600-0000-7000-8000-0000000000f1', number: 'VO-SHOP01' },
  subject: 'الشحن لم يصل',
  orderProblem: null,
  status: 'open',
  lastMessageAt: '2026-11-11T08:00:00.000Z',
  closedAt: null,
  closedBy: null,
  createdAt: '2026-11-11T08:00:00.000Z',
  lastReplier: 'customer',
  escalatedAt: null,
  customer: {
    id: CUSTOMER,
    name: 'سامي علي',
    email: 'sami@example.com',
    phone: '+963944123456',
  },
  unanswered: true,
  canReply: true,
  messages: [
    {
      id: '0199e600-0000-7000-8000-0000000000m1',
      body: 'دفعت ولم يصل الشحن بعد.',
      attachments: [],
      createdAt: '2026-11-11T08:00:00.000Z',
      from: 'customer',
    },
  ],
  ...changes,
});

test.describe('the shop request (SH1–SH3, ST1, ST3)', () => {
  test('checks the slug, previews the colors and confirms a far rate', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/shop', 200, { shop: null })
      .on('GET /api/merchant/shop/slug-available?slug=abu-omar', 200, { available: false })
      .on('GET /api/merchant/shop/slug-available?slug=abu-omar-2', 200, { available: true });
    await page.goto('/merchant/shop');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tools.nav.shop);
    const slug = page.getByRole('textbox', { name: area.request.slug });
    await slug.fill('admin');
    await expect(page.getByText(area.request.slugReserved)).toBeVisible();
    await slug.fill('abu-omar');
    await expect(page.getByText(area.request.slugTaken)).toBeVisible();
    await slug.fill('abu-omar-2');
    await expect(page.getByText(area.request.slugFree)).toBeVisible();

    // A color white text cannot sit on, then a ready swatch: the preview takes it.
    const hex = page.locator('input[name="brandColor"]');
    await hex.fill('#ffff00');
    await expect(page.getByText(area.request.colorWhiteText)).toBeVisible();
    // The swatch's radio is visually hidden: its label, the color, is what one taps.
    await page
      .getByRole('radio', { name: area.request.swatch.replace('{color}', '#2266b3') })
      .locator('..')
      .click();
    await expect(page.getByText(area.request.colorOk)).toBeVisible();
    await expect(page.getByTestId('shop-preview')).toContainText('محل أبو عمر');

    await page.getByRole('button', { name: area.request.rateOwn }).click();
    await page.getByRole('textbox', { name: area.request.rateValue }).fill('16000');
    api.on('POST /api/merchant/shop', 409, {
      statusCode: 409,
      code: 'SHOP_RATE_CONFIRMATION_REQUIRED',
      message: 'far',
      details: { storeRate: '13000' },
    });
    await page.getByRole('button', { name: area.request.submit }).click();
    await expect(page.getByTestId('rate-far')).toContainText('13,000');
    await screenshot(page, testInfo, 'merchant-shop-request');

    api.on('POST /api/merchant/shop', 201, shop({ status: 'requested', slug: 'abu-omar-2' }));
    await page.getByRole('textbox', { name: area.request.rateFarLabel }).fill('أؤكد');
    await page.getByRole('button', { name: area.request.submit }).click();
    await expect(page.getByText(area.request.requestedTitle)).toBeVisible();
    expect(api.last('POST /api/merchant/shop')?.body).toEqual({
      slug: 'abu-omar-2',
      brandColor: '#2266b3',
      rateMode: 'own',
      rate: '16000',
      confirmFar: true,
    });
    expect(api.last('POST /api/merchant/shop')?.headers['idempotency-key']).toBeTruthy();
  });
});

test.describe('an approved shop (ST5, ST6)', () => {
  test('shows the link, limits and settings, and refuses a link in the announcement', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on('GET /api/merchant/shop', 200, { shop: shop() });
    await page.addInitScript(lightTheme);
    await page.goto('/merchant/shop');
    await expect(page.getByTestId('shop-url')).toContainText('/s/abu-omar');
    await expect(page.getByTestId('transferred-today')).toContainText('$150.00');
    const announcement = page.getByRole('textbox', { name: area.settings.announcement });
    await announcement.fill('زورونا www.example.com');
    await page.getByRole('button', { name: area.common.save }).click();
    await expect(page.getByText(area.settings.announcementLink)).toBeVisible();
    api.on('PATCH /api/merchant/shop', 200, shop({ announcement: 'أهلًا بكم، الشحن فوري' }));
    await announcement.fill('أهلًا بكم، الشحن فوري');
    await page.getByRole('button', { name: area.common.save }).click();
    await expect(page.getByText(area.common.saved)).toBeVisible();
    expect(api.last('PATCH /api/merchant/shop')?.body).toMatchObject({
      announcement: 'أهلًا بكم، الشحن فوري',
      rateMode: 'own',
      rate: '13000',
    });
    await expect(page.getByTestId('hidden-games')).toContainText(area.settings.hiddenNone);
    await screenshot(page, testInfo, 'merchant-shop-settings-light');
  });
});

test.describe('the shop customers (CA1, WL1–WL5)', () => {
  test('adds a customer, transfers pounds behind the password check, then hits the cap', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/shop', 200, { shop: shop() })
      .on('GET /api/merchant/shop/customers', 200, { items: [customer()], nextCursor: null })
      .on('GET /api/wallet', 200, { balanceUnits: 500 * USD, syp: null, reservedUsdUnits: 0 });
    await page.goto('/merchant/shop/customers');
    await expect(page.getByTestId('shop-customer')).toContainText('سامي علي');
    await expect(page.getByTestId('customer-balance')).toHaveText('$20.00');
    await screenshot(page, testInfo, 'merchant-shop-customers');

    // A new customer: the merchant's form, the invitation goes by email.
    api.on(
      'POST /api/merchant/shop/customers',
      201,
      customer({
        id: '0199e600-0000-7000-8000-0000000000c2',
        name: 'رامي حسن',
        email: 'rami@example.com',
        state: 'invited',
        balanceUsdUnits: 0,
      }),
    );
    await page.getByRole('button', { name: area.customers.new }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: area.customers.name }).fill('رامي حسن');
    await dialog.getByRole('textbox', { name: area.customers.email }).fill('rami@example.com');
    await dialog.getByRole('textbox', { name: area.customers.phone }).fill('0944555666');
    await dialog.getByRole('button', { name: area.customers.create }).click();
    await expect(
      page.getByText(area.customers.created.replace('{name}', 'رامي حسن')),
    ).toBeVisible();

    // 10,000 pounds at 13,000 credit $0.76; the first send asks for the password.
    await page
      .getByTestId('shop-customer')
      .filter({ hasText: 'سامي علي' })
      .getByRole('button', { name: area.customers.transfer })
      .click();
    const transfer = page.getByRole('dialog');
    await transfer.getByRole('textbox', { name: area.transfer.amountSyp }).fill('10000');
    await expect(transfer.getByTestId('transfer-usd')).toHaveText('$0.76');
    await screenshot(page, testInfo, 'merchant-shop-transfer');
    api.on(`POST /api/merchant/shop/customers/${CUSTOMER}/transfers`, 403, {
      statusCode: 403,
      code: 'REAUTHENTICATION_REQUIRED',
      message: 'check',
    });
    await transfer.getByRole('slider').press('End');
    await expect(transfer.getByText(area.transfer.passwordTitle)).toBeVisible();
    const firstKey = api.last(`POST /api/merchant/shop/customers/${CUSTOMER}/transfers`)?.headers[
      'idempotency-key'
    ];
    api
      .on('POST /api/merchant/shop/transfer-check', 200, {
        checkedUntil: '2030-01-01T00:00:00.000Z',
      })
      .on(`POST /api/merchant/shop/customers/${CUSTOMER}/transfers`, 201, {
        id: '0199e600-0000-7000-8000-0000000000t1',
        amountUsdUnits: 760_000,
        enteredCurrency: 'syp',
        enteredAmountUnits: 1_000_000,
        rate: '13000',
        customerBalanceUsdUnits: 20_760_000,
        merchantBalanceUsdUnits: 499_240_000,
        transferredTodayUsdUnits: 150_760_000,
        createdAt: '2026-11-11T09:00:00.000Z',
      });
    await transfer.locator('input[name="password"]').fill('correct-horse-battery');
    await transfer.getByRole('button', { name: area.transfer.passwordConfirm }).click();
    await expect(transfer.getByText(area.transfer.done.split('{')[0] ?? '')).toBeVisible();
    const sent = api.last(`POST /api/merchant/shop/customers/${CUSTOMER}/transfers`);
    expect(sent?.body).toEqual({
      currency: 'syp',
      amountUnits: 1_000_000,
      expectedUsdUnits: 760_000,
    });
    // The same transfer after the check: the same key, never a second transfer.
    expect(sent?.headers['idempotency-key']).toBe(firstKey);
    await transfer.getByRole('button', { name: area.common.close }).last().click();
    await expect(
      page
        .getByTestId('shop-customer')
        .filter({ hasText: 'سامي علي' })
        .getByTestId('customer-balance'),
    ).toHaveText('$20.76');

    // A second transfer above the customer's balance cap: the largest allowed amount.
    api.on(`POST /api/merchant/shop/customers/${CUSTOMER}/transfers`, 409, {
      statusCode: 409,
      code: 'SHOP_BALANCE_CAP_EXCEEDED',
      message: 'cap',
      details: { largestUsdUnits: 179_240_000 },
    });
    await page
      .getByTestId('shop-customer')
      .filter({ hasText: 'سامي علي' })
      .getByRole('button', { name: area.customers.transfer })
      .click();
    const again = page.getByRole('dialog');
    await again.getByRole('button', { name: area.transfer.usd }).click();
    await again.getByRole('textbox', { name: area.transfer.amountUsd }).fill('190');
    await again.getByRole('slider').press('End');
    await expect(
      again.getByText(area.transfer.capExceeded.replace('{amount}', '⁦$179.24⁩')),
    ).toBeVisible();
  });

  test('asks a customer to return an amount', async ({ page, api }) => {
    signedIn(api)
      .on('GET /api/merchant/shop', 200, { shop: shop() })
      .on('GET /api/merchant/shop/customers', 200, { items: [customer()], nextCursor: null })
      .on(`POST /api/merchant/shop/customers/${CUSTOMER}/return-requests`, 201, {
        id: '0199e600-0000-7000-8000-0000000000r1',
        amountUsdUnits: 5 * USD,
        status: 'pending',
        expiresAt: '2026-11-12T09:00:00.000Z',
        decidedAt: null,
        createdAt: '2026-11-11T09:00:00.000Z',
      });
    await page.goto('/merchant/shop/customers');
    await page
      .getByRole('button', { name: area.customers.more.replace('{name}', 'سامي علي') })
      .click();
    await page.getByRole('menuitem', { name: area.customers.return }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: area.returns.amount }).fill('25');
    await dialog.getByRole('button', { name: area.returns.send }).click();
    await expect(dialog.getByText(area.returns.amountInvalid)).toBeVisible();
    await dialog.getByRole('textbox', { name: area.returns.amount }).fill('5');
    await dialog.getByRole('button', { name: area.returns.send }).click();
    await expect(page.getByText(area.returns.sent.replace('{name}', 'سامي علي'))).toBeVisible();
    await expect(page.getByTestId('shop-customer')).toContainText('$5.00');
    expect(api.last(`POST /api/merchant/shop/customers/${CUSTOMER}/return-requests`)?.body).toEqual(
      { amountUsdUnits: 5 * USD },
    );
  });
});

test.describe('orders, tickets and statistics (PR9, TK2–TK4, SP3)', () => {
  test('lists the orders, answers and escalates a ticket, and shows the statistics', async ({
    page,
    api,
  }, testInfo) => {
    test.setTimeout(90_000);
    signedIn(api).on('GET /api/merchant/shop/orders', 200, {
      items: [
        {
          id: '0199e600-0000-7000-8000-0000000000f1',
          number: 'VO-SHOP01',
          stage: 'delivered',
          customer: { id: CUSTOMER, name: 'سامي علي' },
          productNameAr: '60 شدة',
          gameNameAr: 'ببجي موبايل',
          quantity: 1,
          deliveredQuantity: 1,
          totalSellUsdUnits: 1_200_000,
          marginUsdUnits: 200_000,
          marginState: 'released',
          createdAt: '2026-11-11T07:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    await page.goto('/merchant/shop/orders');
    await expect(page.getByTestId('shop-orders')).toContainText('VO-SHOP01');
    await expect(page.getByTestId('shop-orders')).toContainText(area.orders.marginStates.released);
    await screenshot(page, testInfo, 'merchant-shop-orders');

    const { messages: _messages, canReply: _canReply, ...summary } = ticket();
    api
      .on('GET /api/merchant/shop/tickets', 200, { items: [summary], nextCursor: null })
      .on(`GET /api/merchant/shop/tickets/${TICKET}`, 200, ticket());
    await page.goto('/merchant/shop/tickets');
    await expect(page.getByTestId('shop-tickets')).toContainText(area.tickets.unanswered);
    await page.getByRole('link', { name: /VT-SHOP01/ }).click();
    await expect(page.getByTestId('ticket-customer')).toContainText('sami@example.com');
    const replied = ticket({
      status: 'answered',
      unanswered: false,
      lastReplier: 'shop',
      messages: [
        ...ticket().messages,
        {
          id: '0199e600-0000-7000-8000-0000000000m2',
          body: 'نتابع طلبك الآن.',
          attachments: [],
          createdAt: '2026-11-11T08:05:00.000Z',
          from: 'shop',
        },
      ],
    });
    api.on(`POST /api/merchant/shop/tickets/${TICKET}/messages`, 201, replied);
    await page.getByRole('textbox', { name: area.tickets.reply }).fill('نتابع طلبك الآن.');
    await page.getByRole('button', { name: area.tickets.send, exact: true }).click();
    await expect(page.getByTestId('ticket-thread')).toContainText('نتابع طلبك الآن.');
    expect(
      api.last(`POST /api/merchant/shop/tickets/${TICKET}/messages`)?.headers['idempotency-key'],
    ).toBeTruthy();

    api.on(`POST /api/merchant/shop/tickets/${TICKET}/escalate`, 200, {
      ...replied,
      escalatedAt: '2026-11-11T08:10:00.000Z',
    });
    await page.getByRole('button', { name: area.tickets.escalate }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: area.tickets.note }).fill('المورد لم يسلّم');
    await dialog.getByRole('button', { name: area.tickets.escalate }).click();
    await expect(
      page.getByText(area.tickets.escalatedAt.split('{')[0]?.trim() ?? ''),
    ).toBeVisible();
    expect(api.last(`POST /api/merchant/shop/tickets/${TICKET}/escalate`)?.body).toEqual({
      note: 'المورد لم يسلّم',
    });
    await screenshot(page, testInfo, 'merchant-shop-ticket');

    const day = (date: string, orders: number) => ({
      date,
      visits: orders * 3,
      signUps: 0,
      orders,
      salesUsdUnits: orders * 1_200_000,
      marginReleasedUsdUnits: orders * 200_000,
      transfersUsdUnits: 0,
      returnsUsdUnits: 0,
    });
    const stats: ShopStats = {
      period: 'last_30_days',
      from: '2026-10-13',
      to: '2026-11-11',
      totals: {
        visits: 27,
        signUps: 2,
        activeCustomers: 3,
        orders: 9,
        salesUsdUnits: 10_800_000,
        marginReleasedUsdUnits: 1_800_000,
        transfersUsdUnits: 50 * USD,
        returnsUsdUnits: 5 * USD,
      },
      days: [day('2026-11-09', 2), day('2026-11-10', 3), day('2026-11-11', 4)],
    };
    api.on('GET /api/merchant/shop/stats?period=last_30_days', 200, stats);
    await page.goto('/merchant/shop/stats');
    await expect(page.getByTestId('shop-stats')).toContainText('$10.80');
    await screenshot(page, testInfo, 'merchant-shop-stats');
  });
});

// RTL screenshots of every «متجري» screen, dark and light (the flows above take their own).
for (const name of ['dark', 'light'] as const) {
  test(`merchant shop screenshots, ${name} theme`, async ({ page, api }, testInfo) => {
    test.setTimeout(90_000);
    if (name === 'light') await page.addInitScript(lightTheme);
    const { messages: _messages, canReply: _canReply, ...summary } = ticket();
    signedIn(api)
      .on('GET /api/merchant/shop', 200, { shop: shop() })
      .on('GET /api/merchant/shop/customers', 200, { items: [customer()], nextCursor: null })
      .on('GET /api/wallet', 200, { balanceUnits: 500 * USD, syp: null, reservedUsdUnits: 0 })
      .on('GET /api/merchant/shop/orders', 200, { items: [], nextCursor: null })
      .on('GET /api/merchant/shop/tickets', 200, { items: [summary], nextCursor: null })
      .on(`GET /api/merchant/shop/tickets/${TICKET}`, 200, ticket())
      .on('GET /api/merchant/shop/stats?period=last_30_days', 200, {
        period: 'last_30_days',
        from: '2026-10-13',
        to: '2026-11-11',
        totals: {
          visits: 0,
          signUps: 0,
          activeCustomers: 0,
          orders: 0,
          salesUsdUnits: 0,
          marginReleasedUsdUnits: 0,
          transfersUsdUnits: 0,
          returnsUsdUnits: 0,
        },
        days: [],
      } satisfies ShopStats);
    await page.goto('/merchant/shop');
    await expect(page.getByTestId('shop-url')).toContainText('/s/abu-omar');
    await screenshot(page, testInfo, `merchant-shop-settings-${name}`);
    await page.goto('/merchant/shop/customers');
    await expect(page.getByTestId('shop-customer')).toContainText('سامي علي');
    await screenshot(page, testInfo, `merchant-shop-customers-${name}`);
    await page.goto('/merchant/shop/orders');
    await expect(page.getByText(area.orders.empty)).toBeVisible();
    await screenshot(page, testInfo, `merchant-shop-orders-empty-${name}`);
    await page.goto(`/merchant/shop/tickets/${TICKET}`);
    await expect(page.getByTestId('ticket-customer')).toContainText('sami@example.com');
    await screenshot(page, testInfo, `merchant-shop-ticket-${name}`);
    await page.goto('/merchant/shop/stats');
    await expect(page.getByTestId('shop-stats')).toBeVisible();
    await screenshot(page, testInfo, `merchant-shop-stats-${name}`);
  });

  test(`merchant shop request screenshot, ${name} theme`, async ({ page, api }, testInfo) => {
    if (name === 'light') await page.addInitScript(lightTheme);
    signedIn(api).on('GET /api/merchant/shop', 200, { shop: null });
    await page.goto('/merchant/shop');
    await expect(page.getByTestId('shop-preview')).toBeVisible();
    await screenshot(page, testInfo, `merchant-shop-request-${name}`);
  });
}
