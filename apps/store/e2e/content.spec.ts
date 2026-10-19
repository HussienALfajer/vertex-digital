import ar from '../src/messages/ar.json' with { type: 'json' };
import fixtures from './content-fixtures.json' with { type: 'json' };
import { CONTENT_STORE_URL } from './servers';
import { expect, screenshot, test } from './test';

/*
 * S14 store content: the store on CONTENT_STORE_URL reads published content (e2e/catalog-server.mjs
 * under `/content`), the default store reads none.
 */

const c = ar.content;
const at = (path: string) => `${CONTENT_STORE_URL}${path}`;
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');
const { announcement } = fixtures.site;
/** Removed from the store (owner, 2026-10-19): the API still answers the feed, the store never shows it. */
const ACTIVITY_TITLE = 'آخر التسليمات';

test.describe('home with content (SL1, SL2, AN3)', () => {
  test('the announcement, the banners, no activity card and the footer links', async ({
    page,
    api: _api,
  }, testInfo) => {
    await page.goto(at('/'));
    const bar = page.getByRole('region', { name: c.announcement.label });
    await expect(bar).toContainText(announcement.text);
    await expect(bar.getByRole('link', { name: c.announcement.details })).toHaveAttribute(
      'href',
      '/faq',
    );
    // Under the header, above the page.
    const barBox = await bar.boundingBox();
    const mainBox = await page.locator('main').boundingBox();
    expect(barBox && mainBox && barBox.y < mainBox.y).toBe(true);

    const carousel = page.getByTestId('banner-carousel');
    const first = carousel.getByRole('img', { name: fixtures.site.banners[0]?.altText });
    await expect(first).toHaveAttribute('loading', 'eager');
    await expect(first).toHaveAttribute('fetchpriority', 'high');
    await expect(first).toHaveAttribute('srcset', /w=640/);
    await expect(carousel.getByRole('link').first()).toHaveAttribute('href', '/games/pubg-mobile');
    await expect(
      carousel.getByRole('img', { name: fixtures.site.banners[1]?.altText }),
    ).toHaveAttribute('loading', 'lazy');
    // Two dots; the arrows show from sm (the desktop project).
    await expect(carousel.getByRole('button', { name: /عرض البانر/ })).toHaveCount(2);

    await expect(page.getByRole('heading', { name: ACTIVITY_TITLE })).toHaveCount(0);

    const footer = page.locator('footer');
    await expect(footer.getByRole('link', { name: ar.footer.faq })).toHaveAttribute('href', '/faq');
    await expect(footer.getByRole('link', { name: ar.footer.terms })).toHaveAttribute(
      'href',
      '/terms',
    );
    await expect(footer.getByRole('link', { name: ar.footer.privacy })).toHaveAttribute(
      'href',
      '/privacy',
    );
    await expect(footer.getByRole('link', { name: ar.footer.refund })).toHaveCount(0);
    await expect(footer.getByRole('link', { name: ar.footer.about })).toHaveCount(0);
    await screenshot(page, testInfo, 'home-content-dark');

    await page.addInitScript(lightTheme);
    await page.reload();
    await expect(bar).toBeVisible();
    await screenshot(page, testInfo, 'home-content-light');
  });

  test('without content nothing of it shows', async ({ page, api: _api }, testInfo) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: ar.home.title })).toBeVisible();
    await expect(page.getByRole('region', { name: c.announcement.label })).toHaveCount(0);
    await expect(page.getByTestId('banner-carousel')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: ACTIVITY_TITLE })).toHaveCount(0);
    const footer = page.locator('footer');
    for (const name of [ar.footer.faq, ar.footer.terms, ar.footer.privacy]) {
      await expect(footer.getByRole('link', { name })).toHaveCount(0);
    }
    await screenshot(page, testInfo, 'home-no-content');
    // Unpublished: not found (the status is already sent when the streamed part says so).
    for (const path of ['/terms', '/faq']) {
      await page.goto(path);
      await expect(page.getByText(ar.notFound.title, { exact: true })).toBeVisible();
    }
  });

  test('the carousel advances every 3 seconds in a loop, never under reduced motion', async ({
    page,
    api: _api,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one width is enough for the timing');
    test.setTimeout(40_000);
    await page.goto(at('/'));
    const carousel = page.getByTestId('banner-carousel');
    const dots = carousel.getByRole('button', { name: /عرض البانر/ });
    await expect(dots.first()).toHaveAttribute('aria-current', 'true');
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
    // From the last banner it goes on to the first, and the arrows step both ways.
    await expect(dots.first()).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
    await carousel.getByRole('button', { name: c.banners.previous }).click();
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
    await carousel.getByRole('button', { name: c.banners.next }).click();
    await expect(dots.first()).toHaveAttribute('aria-current', 'true');
    await page.mouse.move(0, 0);

    // Advancing moves the banners only: a visitor who scrolled past them stays where they are.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

    // A tab hidden past the 3 seconds does not stall the loop: back in front, it moves on.
    const setVisibility = (state: 'hidden' | 'visible') =>
      page.evaluate((value) => {
        Object.defineProperty(document, 'visibilityState', { value, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await setVisibility('hidden');
    await page.waitForTimeout(4_000);
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
    await setVisibility('visible');
    await expect(dots.first()).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(dots.first()).toHaveAttribute('aria-current', 'true');
    await page.waitForTimeout(4_000);
    await expect(dots.first()).toHaveAttribute('aria-current', 'true');
    // A dot still moves to its banner.
    await dots.nth(1).click();
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('announcement dismissal (AN4)', () => {
  test('a closed bar stays closed across pages and reloads, without a flash', async ({
    page,
    api: _api,
  }, testInfo) => {
    await page.goto(at('/'));
    const bar = page.getByRole('region', { name: c.announcement.label });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: c.announcement.close }).click();
    await expect(bar).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('vd-announcement-dismissed'))).toBe(
      `${announcement.id}:${announcement.revision}`,
    );

    // Every painted frame is sampled from the start of the next load: the bar must never show.
    await page.addInitScript(() => {
      const w = window as typeof window & { barShown?: boolean };
      w.barShown = false;
      const sample = () => {
        const element = document.querySelector<HTMLElement>('[data-announcement]');
        if (element && element.offsetHeight > 0) w.barShown = true;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto(at('/faq'));
    await expect(page.getByRole('heading', { level: 1, name: c.faq.title })).toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('[data-announcement]')).toBeHidden();
    expect(await page.evaluate(() => (window as { barShown?: boolean }).barShown)).toBe(false);
    await screenshot(page, testInfo, 'announcement-dismissed');

    // Another revision of the announcement shows again (the stored key no longer matches).
    await page.evaluate(() => localStorage.setItem('vd-announcement-dismissed', 'other:1'));
    await page.reload();
    await expect(bar).toBeVisible();
  });
});

test.describe('game page', () => {
  test('shows no delivery feed, though the API answers one', async ({ page, api: _api }) => {
    await page.goto(at('/games/pubg-mobile'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: ACTIVITY_TITLE })).toHaveCount(0);
  });
});

test.describe('content pages (PG2, FQ5, FQ7)', () => {
  test('/faq: jump chips, sections and questions that open', async ({
    page,
    api: _api,
  }, testInfo) => {
    await page.goto(at('/faq'));
    await expect(page.getByRole('heading', { level: 1, name: c.faq.title })).toBeVisible();
    await expect(page.getByText('آخر تحديث: 11 تشرين الأول 2026')).toBeVisible();
    const chips = page.getByRole('navigation', { name: c.faq.sections }).getByRole('link');
    await expect(chips).toHaveText(['الشحن', 'المحفظة']);
    await expect(chips.first()).toHaveAttribute('href', '#s-000000d1');
    const question = page.locator('#q-000000e1');
    await expect(question).not.toHaveAttribute('open');
    await question.getByText('كم يستغرق وصول الشحن؟').click();
    await expect(question).toHaveAttribute('open', '');
    await expect(question.locator('strong')).toHaveText('خلال ثوانٍ');
    await expect(question.getByRole('link', { name: 'طلباتي' })).toHaveAttribute('href', '/orders');
    await expect(page).toHaveTitle(new RegExp(c.faq.title));
    await screenshot(page, testInfo, 'faq-dark');
    await page.addInitScript(lightTheme);
    await page.reload();
    await page.locator('#q-000000e3 summary').click();
    await screenshot(page, testInfo, 'faq-light');
  });

  test('/terms: the title, the update day in Damascus and the body', async ({
    page,
    api: _api,
  }, testInfo) => {
    await page.goto(at('/terms'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('الشروط والأحكام');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByText('آخر تحديث: 11 تشرين الأول 2026')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'المحفظة' })).toHaveAttribute(
      'id',
      'section-1',
    );
    await expect(page.getByRole('heading', { level: 3, name: 'الأكواد' })).toBeVisible();
    await expect(page.locator('article li')).toHaveCount(3);
    await expect(
      page.locator('article blockquote').getByRole('link', { name: 'الدعم' }),
    ).toHaveAttribute('href', '/support');
    await expect(page).toHaveTitle(/الشروط والأحكام/);
    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute('content', /تنظّم هذه الشروط/);
    await screenshot(page, testInfo, 'terms-dark');
    await page.addInitScript(lightTheme);
    await page.reload();
    await screenshot(page, testInfo, 'terms-light');
  });

  test('an unpublished page is not found', async ({ page, api: _api }) => {
    await page.goto(at('/refund'));
    await expect(page.getByText(ar.notFound.title, { exact: true })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).not.toHaveCount(0);
  });

  test('the sitemap lists /faq and the published pages only', async ({ request }) => {
    const sitemap = await (await request.get(at('/sitemap.xml'))).text();
    expect(sitemap).toContain('/faq</loc>');
    expect(sitemap).toContain('/terms</loc>');
    expect(sitemap).toContain('/privacy</loc>');
    expect(sitemap).not.toContain('/refund</loc>');
    const plain = await (await request.get('/sitemap.xml')).text();
    expect(plain).not.toContain('/faq</loc>');
    expect(plain).not.toContain('/terms</loc>');
  });
});

test.describe('sign-up and support (TA1, SL3)', () => {
  test('sign-up names the published pages', async ({ page, api: _api }, testInfo) => {
    await page.goto(at('/sign-up'));
    const sentence = page.getByTestId('terms-agreement');
    await expect(sentence).toContainText(ar.signUp.agreement.prefix);
    await expect(sentence.getByRole('link', { name: ar.signUp.agreement.terms })).toHaveAttribute(
      'href',
      '/terms',
    );
    await expect(sentence.getByRole('link', { name: ar.signUp.agreement.privacy })).toHaveAttribute(
      'href',
      '/privacy',
    );
    await screenshot(page, testInfo, 'sign-up-agreement');

    await page.goto('/sign-up');
    await expect(page.getByRole('heading', { name: ar.signUp.title })).toBeVisible();
    await expect(page.getByTestId('terms-agreement')).toHaveCount(0);
  });

  test('support points to the FAQ before a ticket', async ({ page, api }, testInfo) => {
    api.on('GET /api/support/tickets', 401, { code: 'UNAUTHORIZED' });
    await page.goto(at('/support'));
    const link = page.locator('main').getByRole('link', { name: ar.support.faqCallout.link });
    await expect(link).toHaveAttribute('href', '/faq');
    await screenshot(page, testInfo, 'support-faq-callout');

    await page.goto('/support');
    await expect(page.getByRole('heading', { level: 1, name: ar.support.title })).toBeVisible();
    await expect(page.getByRole('link', { name: ar.support.faqCallout.link })).toHaveCount(0);
  });
});
