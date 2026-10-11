import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { type AdminApi, expect, screenshot, test } from './test';

/*
 * Store content (S14): the four pages with the editor (problems by line, preview, Ctrl+S, publish,
 * versions, the stale dialog, the unsaved guard), the FAQ with its publish bar, banners with the
 * 2:1 refusal and the enabled limit, announcements with the replace confirm, live activity above
 * and below the minimum, and the accepted versions on the customer profile (TA3).
 */

const c = ar.content;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, String(value)),
    text,
  );

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

const GOOD_BODY = [
  'تنظّم هذه الشروط استخدامك للمتجر.',
  '',
  '## المحفظة',
  'تُشحن **بالدولار** ولا تُسحب.',
  '',
  '- الطلب المسلَّم نهائي',
  '- راجع [الأسئلة](/faq)',
].join('\n');

const body = (page: Page) => page.getByLabel(c.pages.body);

test.describe('pages (PG1–PG6)', () => {
  test('a draft with problems is refused by line, then saved, previewed and published', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/content');
    await expect(page).toHaveURL('/content/pages');
    const rows = page.getByRole('row').filter({ has: page.getByRole('cell') });
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: c.pages.unpublished })).toHaveCount(4);

    await rows
      .filter({ hasText: 'الشروط والأحكام' })
      .getByRole('link', { name: c.actions.edit })
      .click();
    await expect(page).toHaveURL('/content/pages/terms');
    await body(page).fill(`${GOOD_BODY}\n<b>x</b>\n[x](https://example.com)`);
    const problems = page.getByRole('alert').filter({ hasText: c.problems.reasons.html });
    await expect(problems).toContainText(
      fill(c.problems.line, { line: 8, reason: c.problems.reasons.html }),
    );
    await expect(problems).toContainText(
      fill(c.problems.line, { line: 9, reason: c.problems.reasons.link }),
    );
    await expect(page.getByText(fill(c.problems.unpublishedLink, { path: '⁦/faq⁩' }))).toBeVisible();
    await page.keyboard.press('Control+s');
    expect(admin.calls).not.toContain('PUT /api/admin/content/pages/terms/draft');
    // The preview renders what is typed, with the store's typography.
    const preview = page.getByTestId('store-preview');
    await expect(preview.getByRole('heading', { level: 2, name: 'المحفظة' })).toBeVisible();
    await expect(preview.locator('img, b')).toHaveCount(0);

    await body(page).fill(GOOD_BODY);
    await expect(problems).toHaveCount(0);
    await expect(page.getByRole('button', { name: c.pages.publish })).toBeDisabled();
    await page.keyboard.press('Control+s');
    await expect(page.getByText(c.pages.saved)).toBeVisible();
    expect(admin.lastBody('PUT /api/admin/content/pages/terms/draft')).toEqual({
      title: 'الشروط والأحكام',
      body: GOOD_BODY,
      revision: 0,
    });

    await page.getByRole('button', { name: c.preview.desktop }).click();
    await expect(preview).toHaveCSS('min-width', '640px');
    await page.getByRole('button', { name: c.pages.publish }).click();
    await expect(page.getByText(c.pages.publishBody)).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: c.pages.publish }).click();
    await expect(page.getByText(fill(c.pages.publishedToast, { version: 1 }))).toBeVisible();
    expect(admin.lastBody('POST /api/admin/content/pages/terms/publish')).toEqual({ revision: 1 });
    const versions = page.getByRole('row').filter({ has: page.getByRole('cell') });
    await expect(versions).toHaveCount(1);
    await expect(versions.first()).toContainText('الشروط والأحكام');

    await expect(page.getByRole('alertdialog')).toBeHidden();
    // Publishing again with no change is refused (edge case 2).
    await page.getByRole('button', { name: c.pages.publish }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: c.pages.publish }).click();
    await expect(page.getByText(ar.errors.api.CONTENT_UNCHANGED)).toBeVisible();
  });

  test('a save after another tab saved offers to reload (PG3)', async ({ page, admin }) => {
    await open(page, admin, '/content/pages/privacy');
    await body(page).fill('نحفظ بريدك فقط.');
    admin.content.saveElsewhere('privacy');
    await page.getByRole('button', { name: c.pages.save }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(c.stale.title);
    await dialog.getByRole('button', { name: c.stale.reload }).click();
    await expect(dialog).toBeHidden();
    await expect(body(page)).toHaveValue('');
    await body(page).fill('نحفظ بريدك فقط.');
    await page.getByRole('button', { name: c.pages.save }).click();
    await expect(page.getByText(c.pages.saved)).toBeVisible();
    expect(admin.lastBody('PUT /api/admin/content/pages/privacy/draft')).toMatchObject({
      revision: 1,
    });
  });

  test('leaving with unsaved changes asks first', async ({ page, admin }) => {
    await open(page, admin, '/content/pages/about');
    await body(page).fill('من نحن');
    await page.getByRole('tab', { name: c.tabs.faq }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(c.pages.leave.title);
    await dialog.getByRole('button', { name: ar.common.cancel }).click();
    await expect(page).toHaveURL('/content/pages/about');
    await page.getByRole('tab', { name: c.tabs.faq }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: c.pages.leave.leave }).click();
    await expect(page).toHaveURL('/content/faq');
  });

  test('a version is viewed and restored into the draft (PG6)', async ({ page, admin }) => {
    admin.content.seedPublished('refund', 'يُعاد المبلغ إلى المحفظة.');
    await open(page, admin, '/content/pages/refund');
    await body(page).fill('مسودة جديدة');
    await page.getByRole('button', { name: c.pages.save }).click();
    await expect(page.getByText(c.pages.saved)).toBeVisible();
    await page.getByRole('button', { name: c.versions.view }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('store-preview')).toContainText('يُعاد المبلغ إلى المحفظة.');
    await dialog.getByRole('button', { name: ar.common.close }).first().click();
    await page.getByRole('button', { name: c.versions.restore }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: c.versions.restore }).click();
    await expect(body(page)).toHaveValue('يُعاد المبلغ إلى المحفظة.');
    expect(admin.lastBody('POST /api/admin/content/pages/refund/versions/1/restore')).toEqual({
      revision: 2,
    });
  });
});

test.describe('FAQ (FQ1–FQ6)', () => {
  test('sections and questions, reorder, archive, preview and publish', async ({ page, admin }) => {
    await open(page, admin, '/content/faq');
    await expect(page.getByText(c.faq.empty)).toBeVisible();
    for (const title of ['الشحن', 'المحفظة']) {
      await page.getByRole('button', { name: c.faq.addSection }).first().click();
      await page.getByRole('dialog').getByLabel(c.faq.sectionTitle).fill(title);
      await page.getByRole('dialog').getByRole('button', { name: c.actions.save }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
    }
    const sections = page.getByTestId('faq-section');
    await expect(sections).toHaveCount(2);

    const questions = [
      ['كم يستغرق الشحن؟', 'تصل أغلب الطلبات **خلال ثوانٍ**.'],
      ['أين أجد معرّف اللاعب؟', 'في صفحة كل لعبة.'],
    ];
    for (const [question, answer] of questions) {
      await sections.first().getByRole('button', { name: c.faq.addQuestion }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(c.faq.question).fill(question as string);
      await dialog.getByLabel(c.faq.answer).fill(answer as string);
      await expect(dialog.getByTestId('store-preview')).toContainText(question as string);
      await dialog.getByRole('button', { name: c.actions.save }).click();
      await expect(dialog).toBeHidden();
    }
    const items = sections.first().getByTestId('faq-item');
    await expect(items).toHaveCount(2);
    await items.first().getByRole('button', { name: c.actions.moveDown }).click();
    await expect(items.first()).toContainText('أين أجد معرّف اللاعب؟');
    expect(admin.lastBody('PUT /api/admin/content/faq/order')).toEqual({
      sections: [
        {
          id: admin.content.sections[0]?.id,
          itemIds: [admin.content.items[0]?.id, admin.content.items[1]?.id],
        },
        { id: admin.content.sections[1]?.id, itemIds: [] },
      ],
    });

    const bar = page.getByTestId('faq-publish-bar');
    await expect(bar).toContainText(c.faq.neverPublished);
    await bar.getByRole('button', { name: c.faq.preview }).click();
    const preview = page.getByRole('dialog').getByTestId('store-preview');
    await expect(preview.locator('details')).toHaveCount(2);
    // A section with no question is left out (FQ5).
    await expect(preview.getByRole('heading', { name: 'المحفظة' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await bar.getByRole('button', { name: c.faq.publish }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: c.faq.publish }).click();
    await expect(page.getByText(c.faq.publishedToast)).toBeVisible();
    await expect(bar.getByRole('button', { name: c.faq.publish })).toBeDisabled();

    // Archiving a question puts the working copy ahead of the publication again (FQ6).
    await items.first().getByRole('button', { name: c.actions.archive }).click();
    await expect(items).toHaveCount(1);
    await expect(bar.getByRole('button', { name: c.faq.publish })).toBeEnabled();
    await page.getByRole('checkbox', { name: c.archivedToggle }).click();
    await expect(page).toHaveURL('/content/faq?archived=true');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText(c.states.archived);
  });
});

test.describe('banners (BN2–BN6)', () => {
  test('a square image is refused, a 2:1 one saved, then enabled', async ({ page, admin }) => {
    await open(page, admin, '/content/banners');
    await expect(page.getByText(c.banners.empty)).toBeVisible();
    await page.getByRole('button', { name: c.banners.add }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(fill(c.banners.guide, { width: 1200, height: 600 }));
    admin.content.nextUpload = 'ratio';
    const file = { name: 'banner.png', mimeType: 'image/png', buffer: Buffer.from('png') };
    await dialog.locator('input[type=file]').setInputFiles(file);
    await expect(dialog.getByRole('alert')).toHaveText(c.banners.imageErrors.ratio);
    admin.content.nextUpload = 'ok';
    await dialog.locator('input[type=file]').setInputFiles(file);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByLabel(c.banners.alt).fill('عرض شدات ببجي');
    await dialog.getByLabel(c.link).fill('https://example.com');
    await dialog.getByRole('button', { name: c.actions.save }).click();
    await expect(dialog.getByText(c.banners.errors.linkPath)).toBeVisible();
    await dialog.getByLabel(c.link).fill('/games/pubg-mobile');
    await dialog.getByRole('button', { name: c.actions.save }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByTestId('banner-row');
    await expect(row).toContainText(c.states.disabled);
    await row.getByRole('switch').click();
    await expect(row).toContainText(c.states.live);
    await expect(page.getByText(fill(c.banners.enabledCount, { count: 1, max: 5 }))).toBeVisible();
  });

  test('a sixth enabled banner is refused (BN3)', async ({ page, admin }) => {
    admin.content.seedBanners(6, 5);
    await open(page, admin, '/content/banners');
    await page.getByTestId('banner-row').last().getByRole('switch').click();
    await expect(page.getByText(ar.errors.api.CONTENT_LIMIT_REACHED)).toBeVisible();
    await expect(page.getByTestId('banner-row').last().getByRole('switch')).not.toBeChecked();
  });
});

test.describe('announcements (AN1, AN2)', () => {
  test('enabling one names the one it replaces', async ({ page, admin }) => {
    const first = admin.content.seedAnnouncement('الشحن يعمل كالمعتاد طوال العيد.', true);
    await open(page, admin, '/content/announcements');
    await page.getByRole('button', { name: c.announcements.add }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(c.announcements.text).fill('صيانة قصيرة الليلة عند الثانية.');
    await dialog.getByRole('button', { name: c.announcements.tones.warning }).click();
    await dialog.getByLabel(c.link).fill('/faq');
    const preview = dialog.getByTestId('announcement-preview');
    await expect(preview.locator('[data-slot=announcement-bar]')).toHaveCount(2);
    await expect(preview).toContainText(c.announcements.details);
    await dialog.getByRole('button', { name: c.actions.save }).click();
    await expect(dialog).toBeHidden();

    const rows = page.getByTestId('announcement-row');
    await rows.last().getByRole('switch').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(fill(c.announcements.replaceBody, { text: first.text }));
    await confirm.getByRole('button', { name: c.announcements.replace }).click();
    await expect(rows.last().getByRole('switch')).toBeChecked();
    await expect(rows.first().getByRole('switch')).not.toBeChecked();
  });
});

const ACTIVITY_ITEMS = [
  ['ببجي موبايل', '660 UC', 1, 14, 5],
  ['فري فاير', '520 جوهرة', 2, 9, 10],
  ['ببجي موبايل', '60 UC', 1, 3, 25],
  ['بطاقات iTunes', '10 دولار', 1, 190, 40],
  ['ببجي موبايل', '325 UC', 1, 7300, 190],
].map(([gameNameAr, productNameAr, quantity, durationSeconds, minutesAgo]) => ({
  gameSlug: 'pubg-mobile',
  gameNameAr: gameNameAr as string,
  productNameAr: productNameAr as string,
  quantity: quantity as number,
  durationSeconds: durationSeconds as number,
  deliveredAt: new Date(
    Math.floor((Date.now() - (minutesAgo as number) * 60_000) / 300_000) * 300_000,
  ).toISOString(),
}));

test.describe('live activity (LA3, LA6)', () => {
  test('below the minimum it says why; above, the card as the store shows it; the switch', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/content/activity');
    await expect(page.getByText(fill(c.activity.belowMinimum, { minimum: 5 }))).toBeVisible();
    await expect(page.getByTestId('activity-count')).toContainText('2');

    admin.content.activity = { qualifyingLast24h: 5, items: ACTIVITY_ITEMS };
    await page.reload();
    const preview = page.getByTestId('store-preview');
    await expect(preview).toContainText('خلال 14 ثانية');
    await expect(preview).toContainText('منذ نحو 5 دقائق');
    await expect(preview).toContainText('520 جوهرة × 2');
    await expect(preview.getByRole('link')).toHaveCount(0);

    await page.getByRole('switch').click();
    await expect(page.getByText(c.activity.off)).toBeVisible();
    expect(admin.lastBody('PUT /api/admin/content/settings')).toEqual({
      liveActivityEnabled: false,
    });
  });
});

test.describe('accepted versions (TA3)', () => {
  test('the profile names the versions, or that the customer signed up before', async ({
    page,
    admin,
  }) => {
    admin.customers.accepted.set(CUSTOMER_IDS.sara, {
      terms: { version: 2, publishedAt: '2026-10-11T09:00:00.000Z' },
      privacy: null,
    });
    await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
    const accepted = page.getByTestId('accepted-versions');
    await expect(accepted).toContainText(
      fill(ar.customers.profile.accepted.terms, { version: 2, date: '' }).replace(' ()', ''),
    );
    await expect(accepted).toContainText(ar.customers.profile.accepted.privacyBefore);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('content screens', async ({ page, admin }, testInfo) => {
      admin.content.seedPublished('terms', GOOD_BODY);
      await open(page, admin, '/content/pages');
      await expect(page.getByRole('row')).toHaveCount(5);
      await screenshot(page, testInfo, `content-pages-${colorScheme}`);

      await page.goto('/content/pages/privacy');
      await body(page).fill(`${GOOD_BODY}\n<b>x</b>\n# عنوان`);
      await expect(page.getByTestId('store-preview')).toContainText('المحفظة');
      await screenshot(page, testInfo, `content-editor-${colorScheme}`, { fullPage: true });

      await page.goto('/content/pages/terms');
      await expect(page.getByRole('button', { name: c.versions.view })).toBeVisible();
      await screenshot(page, testInfo, `content-versions-${colorScheme}`, { fullPage: true });

      admin.content.sections.push({
        id: '0199e000-0000-7000-8000-0000000000d1',
        title: 'الشحن',
        archivedAt: null,
        createdAt: '2026-10-11T08:00:00.000Z',
        updatedAt: '2026-10-11T08:00:00.000Z',
      });
      admin.content.items.push({
        id: '0199e000-0000-7000-8000-0000000000e1',
        sectionId: '0199e000-0000-7000-8000-0000000000d1',
        question: 'كم يستغرق وصول الشحن؟',
        answer: 'تصل أغلب الطلبات **خلال ثوانٍ**.',
        archivedAt: null,
        createdAt: '2026-10-11T08:00:00.000Z',
        updatedAt: '2026-10-11T08:00:00.000Z',
      });
      admin.content.faqRevision = 2;
      admin.content.faqChangedAt = new Date(Date.now() - 12 * 60_000).toISOString();
      await page.goto('/content/faq');
      await expect(page.getByTestId('faq-item')).toHaveCount(1);
      await screenshot(page, testInfo, `content-faq-${colorScheme}`);

      admin.content.seedBanners(3, 2);
      await page.goto('/content/banners');
      await expect(page.getByTestId('banner-row')).toHaveCount(3);
      await screenshot(page, testInfo, `content-banners-${colorScheme}`);
      await page.getByRole('button', { name: c.banners.add }).click();
      admin.content.nextUpload = 'ratio';
      await page
        .getByRole('dialog')
        .locator('input[type=file]')
        .setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: Buffer.from('png') });
      await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
      await screenshot(page, testInfo, `content-banner-dialog-${colorScheme}`);
      await page.keyboard.press('Escape');

      admin.content.seedAnnouncement('الشحن يعمل كالمعتاد طوال العيد.', true);
      admin.content.seedAnnouncement('صيانة قصيرة الليلة عند الثانية.', false);
      await page.goto('/content/announcements');
      await page.getByTestId('announcement-row').last().getByRole('switch').click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await screenshot(page, testInfo, `content-announcement-replace-${colorScheme}`);
      await page.getByRole('alertdialog').getByRole('button', { name: ar.common.cancel }).click();
      await page
        .getByTestId('announcement-row')
        .first()
        .getByRole('button', { name: c.actions.edit })
        .click();
      await expect(page.getByTestId('announcement-preview')).toBeVisible();
      await screenshot(page, testInfo, `content-announcement-dialog-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/content/activity');
      await expect(page.getByText(fill(c.activity.belowMinimum, { minimum: 5 }))).toBeVisible();
      await screenshot(page, testInfo, `content-activity-below-${colorScheme}`);
      admin.content.activity = { qualifyingLast24h: 9, items: ACTIVITY_ITEMS };
      await page.reload();
      await expect(page.getByTestId('store-preview')).toBeVisible();
      await screenshot(page, testInfo, `content-activity-${colorScheme}`, { fullPage: true });
    });
  });
}
