import type { Page } from '@playwright/test';
import type { MerchantApplication, MerchantApplicationState } from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG, pack } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S20 merchant accounts in the store: the account page's card (soon, apply, status, merchant),
 * the four-step application with its photo and summary, its states (under review, information
 * requested with the edited resubmission, rejected with the reapply date), the withdrawal, and
 * the terms sheet of a directly granted merchant, from the account page and from a refused buy.
 */

const m = ar.merchant;
const TERMS = '0199e000-0000-7000-8000-0000000000e1';
const APPLICATION = '0199e000-0000-7000-8000-0000000000e2';
const PHOTO = '0199e000-0000-7000-8000-0000000000e3';
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

function signedIn(api: MockApi): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: 'سارة الأحمد', email: 'sara@example.com', emailVerified: true },
      session: { token: 'this-device' },
    })
    .on('GET /api/auth/list-sessions', 200, []);
}

const open = (changes: Partial<MerchantApplicationState> = {}): MerchantApplicationState => ({
  application: null,
  canApply: true,
  availableAt: null,
  termsVersionId: TERMS,
  ...changes,
});

const application = (changes: Partial<MerchantApplication> = {}): MerchantApplication => ({
  id: APPLICATION,
  status: 'under_review',
  tradeName: 'محل النور للاتصالات',
  activity: 'phone_shop',
  activityOther: null,
  yearsInBusiness: '1_3',
  governorate: 'aleppo',
  city: 'اعزاز',
  streetAddress: 'شارع السوق، قرب الجامع الكبير',
  whatsapp: '+963944123456',
  telegramUsername: null,
  monthlyVolume: '500_2000',
  productInterests: ['game_topups', 'gift_cards'],
  salesChannels: ['shop_counter'],
  shopPhotoFileId: null,
  shopLink: null,
  heardFrom: null,
  adminMessage: null,
  submittedAt: '2026-10-20T09:00:00.000Z',
  infoRequestedAt: null,
  expiresAt: null,
  decidedAt: null,
  events: [{ event: 'submitted', message: null, createdAt: '2026-10-20T09:00:00.000Z' }],
  ...changes,
});

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}

const next = (page: Page) => page.getByRole('button', { name: m.next }).click();

test.describe('merchant accounts', () => {
  test('the account card says "soon" before the merchant terms are published (MT1)', async ({
    page,
    api,
  }) => {
    signedIn(api);
    await page.goto('/account');
    const card = page.getByTestId('merchant-card');
    await expect(card).toContainText(m.card.soonHint);
    await expect(card.getByRole('link')).toHaveCount(0);
  });

  test('applies in four steps with a photo, then shows the application under review', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/application', 200, open())
      .on('POST /api/merchant/application/photo', 201, { fileId: PHOTO })
      .on('POST /api/merchant/application', 201, application({ shopPhotoFileId: PHOTO }))
      .image(`GET /api/merchant/application/photo/${PHOTO}`);
    await page.goto('/account');
    await page.getByRole('link', { name: m.card.applyAction }).click();
    await expect(page).toHaveURL('/account/merchant');

    // Step 1: nothing filled is refused in place.
    await next(page);
    await expect(page.getByText(m.validation.tradeName)).toBeVisible();
    await page.getByLabel(m.fields.tradeName).fill('محل النور للاتصالات');
    await choose(page, m.fields.activity, m.activities.phone_shop);
    await page.getByRole('button', { name: m.years['1_3'] }).click();
    await choose(page, m.fields.governorate, m.governorates.aleppo);
    await page.getByLabel(m.fields.city).fill('اعزاز');
    await page.getByLabel(m.fields.streetAddress).fill('شارع السوق، قرب الجامع الكبير');
    await screenshot(page, testInfo, 'merchant-step-shop');
    await next(page);

    // Step 2: the account's name and phone.
    await expect(page.getByLabel(m.fields.contactName)).toHaveValue('سارة الأحمد');
    await expect(page.getByLabel(m.fields.whatsapp)).toHaveValue('+963944123456');
    await next(page);

    // Step 3.
    await choose(page, m.fields.monthlyVolume, m.volumes['500_2000']);
    await page.getByRole('checkbox', { name: m.interests.game_topups }).check();
    await page.getByRole('checkbox', { name: m.interests.gift_cards }).check();
    await page.getByRole('checkbox', { name: m.channels.shop_counter }).check();
    await next(page);

    // Step 4: the photo, the link and the terms.
    await page.getByTestId('shop-photo-input').setInputFiles({
      name: 'shop.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(page.getByRole('img', { name: m.fields.shopPhoto })).toBeVisible();
    await page.getByRole('button', { name: m.review }).click();
    await expect(page.getByText(m.validation.terms)).toBeVisible();
    await page.getByRole('checkbox', { name: new RegExp(m.fields.termsLink) }).check();
    await page.getByRole('button', { name: m.review }).click();
    await expect(page.getByRole('heading', { name: m.summaryTitle })).toBeVisible();
    await screenshot(page, testInfo, 'merchant-summary');

    api.on(
      'GET /api/merchant/application',
      200,
      open({ application: application(), canApply: false }),
    );
    await page.getByRole('button', { name: m.submit }).click();
    await expect(page.getByTestId('merchant-status')).toContainText(m.statuses.under_review);
    const sent = api.last('POST /api/merchant/application');
    expect(sent?.headers['idempotency-key']).toBeTruthy();
    expect(sent?.body).toMatchObject({
      tradeName: 'محل النور للاتصالات',
      activity: 'phone_shop',
      governorate: 'aleppo',
      whatsapp: '+963944123456',
      productInterests: ['game_topups', 'gift_cards'],
      salesChannels: ['shop_counter'],
      shopPhotoFileId: PHOTO,
      termsVersionId: TERMS,
    });
    await screenshot(page, testInfo, 'merchant-under-review');
  });

  test('answers a request for information by editing and resubmitting (MA4)', async ({
    page,
    api,
  }, testInfo) => {
    const requested = application({
      status: 'info_requested',
      adminMessage: 'أرسل صورة واضحة لواجهة المحل',
      infoRequestedAt: '2026-10-20T12:00:00.000Z',
      expiresAt: '2026-10-27T12:00:00.000Z',
      events: [
        { event: 'submitted', message: null, createdAt: '2026-10-20T09:00:00.000Z' },
        {
          event: 'info_requested',
          message: 'أرسل صورة واضحة لواجهة المحل',
          createdAt: '2026-10-20T12:00:00.000Z',
        },
      ],
    });
    signedIn(api)
      .on('GET /api/merchant/application', 200, open({ application: requested, canApply: false }))
      .on('PUT /api/merchant/application', 200, application({ tradeName: 'محل النور' }));
    await page.goto('/account/merchant');
    await expect(page.getByText('أرسل صورة واضحة لواجهة المحل').first()).toBeVisible();
    await screenshot(page, testInfo, 'merchant-info-requested');
    await page.getByLabel(m.fields.tradeName).fill('محل النور');
    for (let step = 0; step < 3; step += 1) await next(page);
    await page.getByRole('checkbox', { name: new RegExp(m.fields.termsLink) }).check();
    await page.getByRole('button', { name: m.review }).click();
    api.on(
      'GET /api/merchant/application',
      200,
      open({ application: application(), canApply: false }),
    );
    await page.getByRole('button', { name: m.resubmit }).click();
    await expect(page.getByTestId('merchant-status')).toContainText(m.statuses.under_review);
    expect(api.last('PUT /api/merchant/application')?.body).toMatchObject({
      tradeName: 'محل النور',
    });
  });

  test('shows a rejection with its reason and the day to reapply, then withdraws a new one', async ({
    page,
    api,
  }, testInfo) => {
    const rejected = application({
      status: 'rejected',
      adminMessage: 'لم نتمكن من التحقق من المحل',
      decidedAt: '2026-10-20T15:00:00.000Z',
    });
    signedIn(api).on(
      'GET /api/merchant/application',
      200,
      open({ application: rejected, canApply: false, availableAt: '2026-10-27T15:00:00.000Z' }),
    );
    await page.addInitScript(lightTheme);
    await page.goto('/account/merchant');
    await expect(page.getByText(/لم نتمكن من التحقق من المحل/)).toBeVisible();
    await expect(page.getByText(/يمكنك التقديم من جديد ابتداءً من/)).toBeVisible();
    await expect(page.getByRole('button', { name: m.state.applyAgain })).toHaveCount(0);
    await screenshot(page, testInfo, 'merchant-rejected-light');

    api
      .on(
        'GET /api/merchant/application',
        200,
        open({ application: application(), canApply: false }),
      )
      .on('POST /api/merchant/application/withdraw', 200, application({ status: 'withdrawn' }));
    await page.reload();
    await page.getByRole('button', { name: m.state.withdraw }).click();
    api.on(
      'GET /api/merchant/application',
      200,
      open({ application: application({ status: 'withdrawn' }) }),
    );
    await page.getByRole('button', { name: m.state.withdrawConfirm }).click();
    await expect(page.getByTestId('merchant-status')).toContainText(m.statuses.withdrawn);
    await expect(page.getByRole('button', { name: m.state.applyAgain })).toBeVisible();
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`a directly granted merchant accepts the terms from the account page (${theme})`, async ({
      page,
      api,
    }, testInfo) => {
      const merchant = (termsAccepted: boolean) => ({
        id: '0199e000-0000-7000-8000-0000000000aa',
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        phone: '+963944123456',
        createdAt: '2026-10-01T09:00:00.000Z',
        priceKind: 'wholesale',
        accountType: 'merchant',
        merchant: { tradeName: 'متجر الشام', termsAccepted },
      });
      signedIn(api)
        .on('GET /api/account', 200, merchant(false))
        .on('GET /api/merchant/application', 200, open({ canApply: false }))
        .on('POST /api/merchant/terms', 204, null);
      if (theme === 'light') await page.addInitScript(lightTheme);
      await page.goto('/account');
      const card = page.getByTestId('merchant-card');
      await expect(card).toContainText('متجر الشام');
      await card.getByRole('button', { name: m.card.termsAction }).click();
      const sheet = page.getByTestId('terms-sheet');
      await expect(sheet.getByRole('button', { name: m.terms.accept })).toBeDisabled();
      await sheet.getByRole('checkbox', { name: m.terms.check }).check();
      await screenshot(page, testInfo, `merchant-terms-sheet-${theme}`);
      api.on('GET /api/account', 200, merchant(true));
      await sheet.getByRole('button', { name: m.terms.accept }).click();
      await expect(card.getByText(m.card.termsBanner)).toHaveCount(0);
      expect(api.last('POST /api/merchant/terms')?.body).toEqual({ versionId: TERMS });
    });
  }

  test('a refused buy without the merchant terms opens the sheet (MT2)', async ({ page, api }) => {
    const p60 = pack(PUBG, '60 UC');
    signedIn(api)
      .on('GET /api/wallet', 200, { balanceUnits: 50_000_000, syp: null, reservedUsdUnits: 0 })
      .on('POST /api/player-checks', 200, { result: 'not_supported' })
      .on('POST /api/orders', 409, { code: 'MERCHANT_TERMS_REQUIRED' })
      .on('GET /api/merchant/application', 200, open({ canApply: false }));
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    const box = page
      .getByRole('dialog')
      .or(page.getByRole('complementary', { name: ar.game.buyBox }));
    await box.getByLabel('معرّف اللاعب (ID)').fill('51234567');
    await box.getByRole('button', { name: ar.purchase.continue }).click();
    await box.getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect.poll(() => api.last('POST /api/orders')).toBeDefined();
    const sheet = page.getByTestId('terms-sheet');
    await expect(sheet).toBeVisible();
    // Accepted: the customer is told nothing was paid and to slide again (audit A04-31).
    api.on('POST /api/merchant/terms', 204, null);
    await sheet.getByRole('checkbox', { name: m.terms.check }).check();
    await sheet.getByRole('button', { name: m.terms.accept }).click();
    await expect(box.getByText(m.terms.slideAgain)).toBeVisible();
    await expect(box.getByRole('slider')).toBeVisible();
  });
});
