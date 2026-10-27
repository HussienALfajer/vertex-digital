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
    await expect(rows).toHaveCount(5);
    await expect(rows.filter({ hasText: c.pages.unpublished })).toHaveCount(5);

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
    await page.getByRole('alertdialog').getByRole('button', { name: c.actions.archive }).click();
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

/*
 * Delivery times as the API answers them (LA4: floored to 5 minutes), relative to when a test sets
 * them. The newest is in the current 5 minutes, so it reads "منذ نحو 5 دقائق" for 5 minutes at
 * least ("at least 5" covers 0 to 10 minutes): a delivery floored from 5 minutes ago would turn
 * into "10" as soon as the next 5-minute mark passed before the preview rendered.
 */
const activityItems = () =>
  [
    ['ببجي موبايل', '660 UC', 1, 14, 0],
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

    admin.content.activity = { qualifyingLast24h: 5, items: activityItems() };
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

/** A section and a question in the working copy, the copy ahead of any publication. */
function seedFaq(admin: AdminApi, options: { sectionArchived?: boolean } = {}) {
  admin.content.sections.push({
    id: '0199e000-0000-7000-8000-0000000000d1',
    title: 'الشحن',
    archivedAt: options.sectionArchived ? '2026-10-11T08:30:00.000Z' : null,
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
}

test.describe('audit A08', () => {
  const failing = { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' };

  test('archiving a banner, an announcement or a FAQ row asks first, naming it (A08-5)', async ({
    page,
    admin,
  }) => {
    admin.content.seedBanners(2, 1);
    await open(page, admin, '/content/banners');
    const live = page.getByTestId('banner-row').first();
    await live.getByRole('button', { name: c.actions.archive }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(fill(c.banners.archiveTitle, { name: 'عرض رقم 1' }));
    await expect(confirm).toContainText(c.banners.archiveLiveBody);
    await confirm.getByRole('button', { name: ar.common.cancel }).click();
    expect(admin.calls.filter((call) => call.endsWith('/archive'))).toEqual([]);
    await live.getByRole('button', { name: c.actions.archive }).click();
    await confirm.getByRole('button', { name: c.actions.archive }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId('banner-row')).toHaveCount(1);

    const shown = admin.content.seedAnnouncement('الشحن يعمل كالمعتاد طوال العيد.', true);
    await page.goto('/content/announcements');
    await page
      .getByTestId('announcement-row')
      .getByRole('button', { name: c.actions.archive })
      .click();
    await expect(confirm).toContainText(
      fill(c.announcements.archiveLiveBody, { text: shown.text }),
    );
    await confirm.getByRole('button', { name: c.actions.archive }).click();
    await expect(page.getByTestId('announcement-row')).toHaveCount(0);

    seedFaq(admin);
    await page.goto('/content/faq');
    await page
      .getByTestId('faq-section')
      .getByRole('button', { name: fill(c.actions.archiveNamed, { name: 'الشحن' }) })
      .click();
    await expect(confirm).toContainText(fill(c.faq.archiveSectionTitle, { title: 'الشحن' }));
    await confirm.getByRole('button', { name: ar.common.cancel }).click();
    await page.getByTestId('faq-item').getByRole('button', { name: c.actions.archive }).click();
    await expect(confirm).toContainText(
      fill(c.faq.archiveItemBody, { question: 'كم يستغرق وصول الشحن؟' }),
    );
  });

  test('a failed read after a save keeps the editor and what is typed (A08-6)', async ({
    page,
    admin,
  }) => {
    let fail = false;
    await page.route('**/api/admin/content/pages/privacy', (route) =>
      fail && route.request().method() === 'GET'
        ? route.fulfill({ status: 500, json: failing })
        : route.fallback(),
    );
    await open(page, admin, '/content/pages/privacy');
    await body(page).fill('نحفظ بريدك فقط.');
    fail = true;
    await page.getByRole('button', { name: c.pages.save }).click();
    await expect(page.getByText(c.staleRead)).toBeVisible({ timeout: 10_000 });
    await expect(body(page)).toHaveValue('نحفظ بريدك فقط.');
    await body(page).fill('نحفظ بريدك فقط، ولا نشاركه.');
    fail = false;
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByText(c.staleRead)).toBeHidden();
    await expect(body(page)).toHaveValue('نحفظ بريدك فقط، ولا نشاركه.');
  });

  test('the stale dialog copies the typed edits before the reload (A08-9)', async ({
    page,
    admin,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, admin, '/content/pages/privacy');
    await body(page).fill('نص طويل كتبته للتو.');
    admin.content.saveElsewhere('privacy');
    await page.getByRole('button', { name: c.pages.save }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: c.stale.copy }).click();
    await expect(dialog.getByRole('button', { name: c.stale.copied })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      'نص طويل كتبته للتو.',
    );
  });

  test('an unchanged draft is not saved again, and Ctrl+S waits under a dialog (A08-24)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/content/pages/about');
    await expect(body(page)).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect(page.getByText(c.pages.nothingToSave)).toBeVisible();
    expect(admin.calls).not.toContain('PUT /api/admin/content/pages/about/draft');
  });

  test('publishing a FAQ changed meanwhile closes the dialog and asks for a review (A08-13)', async ({
    page,
    admin,
  }) => {
    seedFaq(admin);
    await open(page, admin, '/content/faq');
    const bar = page.getByTestId('faq-publish-bar');
    await expect(bar).toContainText(fill(c.faq.unpublishedSince, { since: '' }).trim());
    await bar.getByRole('button', { name: c.faq.publish }).click();
    admin.content.faqRevision += 1;
    await page.getByRole('alertdialog').getByRole('button', { name: c.faq.publish }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(bar).toContainText(c.faq.stale);
  });

  test('a question under an archived section offers no edit (A08-17)', async ({ page, admin }) => {
    seedFaq(admin, { sectionArchived: true });
    await open(page, admin, '/content/faq?archived=true');
    const item = page.getByTestId('faq-item');
    await expect(item).toContainText('كم يستغرق وصول الشحن؟');
    await expect(item.getByRole('button', { name: c.actions.edit })).toHaveCount(0);
  });

  test('a reorder refused as stale says the list changed (A08-12)', async ({ page, admin }) => {
    admin.content.seedBanners(2, 0);
    await page.route('**/api/admin/content/banners/order', (route) =>
      route.fulfill({
        status: 400,
        json: { statusCode: 400, code: 'VALIDATION_FAILED', message: 'x', details: [] },
      }),
    );
    await open(page, admin, '/content/banners');
    await page
      .getByTestId('banner-row')
      .first()
      .getByRole('button', { name: c.actions.moveDown })
      .click();
    await expect(page.getByText(c.reorderStale)).toBeVisible();
  });

  test('an announcement cut on a phone warns in its dialog (A08-32)', async ({ page, admin }) => {
    await open(page, admin, '/content/announcements');
    await page.getByRole('button', { name: c.announcements.add }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(c.announcements.text).fill('صيانة قصيرة الليلة.');
    await expect(dialog.getByTestId('phone-clip')).toHaveCount(0);
    await dialog
      .getByLabel(c.announcements.text)
      .fill(
        'خصم 5% على كل بطاقات iTunes وGoogle Play حتى نهاية الأسبوع، ويصل الشحن خلال ثوانٍ لكل الطلبات.',
      );
    await expect(dialog.getByTestId('phone-clip')).toHaveText(c.announcements.phoneClip);
    // Edge case 20 for a link field (A08-15): a page not published yet.
    await dialog.getByLabel(c.link).fill('/merchant-terms');
    await expect(
      dialog.getByText(fill(c.problems.unpublishedLink, { path: '⁦/merchant-terms⁩' })),
    ).toBeVisible();
  });

  test('the preview follows the switch, and the note says the store shows no feed (A08-7, A08-8)', async ({
    page,
    admin,
  }) => {
    admin.content.activity = { qualifyingLast24h: 5, items: activityItems() };
    await open(page, admin, '/content/activity');
    await expect(page.getByText(c.activity.on)).toBeVisible();
    await expect(page.getByTestId('store-preview')).toBeVisible();
    await page.getByRole('switch').click();
    await expect(page.getByText(c.activity.offPreview)).toBeVisible();
    await expect(page.getByTestId('store-preview')).toHaveCount(0);
  });

  test('the pages list shows the merchant terms at their store path (A08-16)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/content/pages');
    await expect(page.getByText('/merchant-terms', { exact: true })).toBeVisible();
    await expect(page.getByText('/merchant_terms')).toHaveCount(0);
  });

  test('a test customer made in the panel accepted nothing (A08-28)', async ({ page, admin }) => {
    await open(page, admin, `/customers/${CUSTOMER_IDS.test}`);
    await expect(page.getByTestId('accepted-versions')).toHaveText(
      ar.customers.profile.accepted.testCustomer,
    );
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('content screens', async ({ page, admin }, testInfo) => {
      admin.content.seedPublished('terms', GOOD_BODY);
      await open(page, admin, '/content/pages');
      await expect(page.getByRole('row')).toHaveCount(6);
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
      admin.content.activity = { qualifyingLast24h: 9, items: activityItems() };
      await page.reload();
      await expect(page.getByTestId('store-preview')).toBeVisible();
      await screenshot(page, testInfo, `content-activity-${colorScheme}`, { fullPage: true });
    });
  });
}
