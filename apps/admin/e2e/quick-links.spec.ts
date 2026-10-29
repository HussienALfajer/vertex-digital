import { readFile, writeFile } from 'node:fs/promises';
import type { Download, Locator, Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type BusyCover, busyCover, decodePng } from './qr-decode';
import { type AdminApi, expect, screenshot, test } from './test';

/*
 * S22 PR 1 in the panel: a pack's direct buy link with its campaign tag and QR (DL5), the game's
 * best-value switch (BV1) and the links' counts (DL5), against the mocked API.
 */

async function scene(admin: AdminApi) {
  admin.signedIn = true;
  const game = admin.catalog.addGame({
    categorySlug: 'games',
    slug: 'pubg-mobile',
    nameAr: 'ببجي موبايل',
    nameEn: 'PUBG Mobile',
    status: 'active',
    cover: busyCover('blocks'),
  });
  admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
  const small = admin.catalog.addProduct(game.id, { nameAr: '60 شدة', gameAmount: 60 });
  const large = admin.catalog.addProduct(game.id, { nameAr: '660 شدة', gameAmount: 660 });
  admin.catalog.quickLinks = [
    {
      productId: large.id,
      productNameAr: large.nameAr,
      gameNameAr: game.nameAr,
      quickCode: large.quickCode,
      campaign: 'whatsapp',
      opens: 42,
      orders: 5,
      revenueUsdUnits: 49_950_000,
    },
    {
      productId: small.id,
      productNameAr: small.nameAr,
      gameNameAr: game.nameAr,
      quickCode: small.quickCode,
      campaign: null,
      opens: 9,
      orders: 1,
      revenueUsdUnits: 990_000,
    },
  ];
  return { game, small, large };
}

const productRow = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });

async function downloaded(page: Page, button: Locator): Promise<{ name: string; bytes: Buffer }> {
  const download: Promise<Download> = page.waitForEvent('download');
  await button.click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path()) as string) };
}

/** The downloaded SVG drawn by the browser alone, as a PNG: it must need nothing but itself. */
async function svgAsPng(page: Page, svg: string): Promise<Buffer> {
  const url = await page.evaluate(async (markup) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    canvas.getContext('2d')?.drawImage(image, 0, 0, 1024, 1024);
    return canvas.toDataURL('image/png');
  }, svg);
  return Buffer.from(url.split(',')[1] as string, 'base64');
}

test.describe('direct buy links (S22 DL5)', () => {
  test('shows a pack’s link, tags it with a campaign and offers its QR', async ({
    page,
    admin,
  }) => {
    const { game, large } = await scene(admin);
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    await productRow(page, '660 شدة')
      .getByRole('button', { name: ar.catalog.quickLink.open })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('quick-link')).toHaveText(large.quickLinkUrl);
    await expect(dialog.getByRole('img', { name: ar.catalog.quickLink.qr })).toBeVisible();

    const campaign = dialog.getByLabel(ar.catalog.quickLink.campaign);
    await campaign.fill('Bad Tag');
    await expect(dialog.getByText(ar.catalog.quickLink.campaignInvalid)).toBeVisible();
    await expect(dialog.getByTestId('quick-link')).toHaveText(large.quickLinkUrl);
    await campaign.fill('whatsapp');
    await expect(dialog.getByTestId('quick-link')).toHaveText(`${large.quickLinkUrl}?c=whatsapp`);

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: ar.catalog.quickLink.png }).click();
    expect((await download).suggestedFilename()).toBe(`${large.quickCode}-whatsapp.png`);
    const svg = page.waitForEvent('download');
    await dialog.getByRole('button', { name: ar.catalog.quickLink.svg }).click();
    expect((await svg).suggestedFilename()).toBe(`${large.quickCode}-whatsapp.svg`);

    await dialog.getByRole('link', { name: ar.catalog.quickLink.stats }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/quick-links\\?productId=${large.id}`));
    await expect(page.getByRole('row')).toHaveCount(3);
  });

  test('puts the game’s cover in the QR, and every download still scans to the exact link', async ({
    page,
    admin,
  }, testInfo) => {
    test.setTimeout(90_000);
    admin.signedIn = true;
    const covers: (BusyCover | null)[] = ['blocks', 'modules', 'stripes', null];
    for (const [index, kind] of covers.entries()) {
      const game = admin.catalog.addGame({
        categorySlug: 'games',
        slug: `game-${index}`,
        nameAr: `لعبة ${index}`,
        nameEn: `Game ${index}`,
        status: 'active',
        cover: kind === null ? false : busyCover(kind, index + 1),
      });
      const pack = admin.catalog.addProduct(game.id, { nameAr: '660 شدة', gameAmount: 660 });
      admin.catalog.pricing = () => ({
        price: { priceUsdUnits: 9_990_000, minMarginUsdUnits: 100_000 },
        usableRouteCostsUsdUnits: [9_000_000],
        basisSupplierNameAr: 'WDGZone',
        basisCostUsdUnits: 9_000_000,
        basisStockLevel: null,
        priceHeld: false,
        routed: true,
        reviewOpen: false,
      });
      const link = `${pack.quickLinkUrl}?c=sticker_${index}`;

      await page.goto(`/catalog/games/${game.id}?tab=products`);
      await productRow(page, '660 شدة')
        .getByRole('button', { name: ar.catalog.quickLink.open })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(ar.catalog.quickLink.campaign).fill(`sticker_${index}`);
      const qr = dialog.getByRole('img', { name: ar.catalog.quickLink.qr });
      await expect(qr).toHaveAttribute('aria-busy', 'false');
      // A game without a cover keeps the plain QR.
      await expect(qr.locator('image')).toHaveCount(kind === null ? 0 : 1);
      if (kind !== null) {
        await expect(qr.locator('image')).toHaveAttribute('href', /^data:image\/png;base64,/);
      }

      const png = await downloaded(
        page,
        dialog.getByRole('button', { name: ar.catalog.quickLink.png }),
      );
      expect(png.name).toBe(`${pack.quickCode}-sticker_${index}.png`);
      expect(decodePng(png.bytes)).toEqual({ width: 1024, height: 1024, text: link });

      const svg = await downloaded(
        page,
        dialog.getByRole('button', { name: ar.catalog.quickLink.svg }),
      );
      const markup = svg.bytes.toString('utf8');
      expect(markup).not.toMatch(/\/api\/catalog\/images|blob:/);
      expect(decodePng(await svgAsPng(page, markup)).text).toBe(link);

      // The card leaves the price off unless asked: the link outlives prices.
      const price = dialog.getByRole('checkbox', { name: ar.catalog.quickLink.cardPrice });
      await expect(price).not.toBeChecked();
      const cardButton = dialog.getByRole('button', { name: ar.catalog.quickLink.card });
      const card = await downloaded(page, cardButton);
      expect(card.name).toBe(`${pack.quickCode}-sticker_${index}-card.png`);
      expect(decodePng(card.bytes)).toEqual({ width: 1240, height: 1748, text: link });
      await price.click();
      const priced = await downloaded(page, cardButton);
      expect(decodePng(priced.bytes).text).toBe(link);
      expect(priced.bytes.equals(card.bytes)).toBe(false);
      // The cards are the print review's evidence, beside the screenshots.
      const path = testInfo.outputPath(`card-${kind ?? 'no-cover'}.png`);
      await writeFile(path, priced.bytes);
      await testInfo.attach(`card-${kind ?? 'no-cover'}`, { path, contentType: 'image/png' });
    }
  });

  test('turns the best-value badge off for a game', async ({ page, admin }) => {
    const { game } = await scene(admin);
    await page.goto(`/catalog/games/${game.id}`);
    const toggle = page.getByRole('switch', { name: ar.catalog.game.bestValue, exact: true });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(admin.lastBody(`PATCH /api/admin/catalog/games/${game.id}`)).toEqual({
      bestValueEnabled: false,
    });
  });

  test('lists the counts per pack and campaign, sorted and totalled', async ({ page, admin }) => {
    await scene(admin);
    await page.goto('/catalog/quick-links');
    const rows = page.getByRole('row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText('660 شدة');
    await expect(rows.nth(1)).toContainText('whatsapp');
    await expect(rows.last()).toContainText(ar.reports.totals);
    await expect(rows.last()).toContainText('51');
    await expect(rows.last()).toContainText('$50.94');
    const [query] = admin.catalog.quickLinkQueries;
    expect(Date.parse(query?.to ?? '') - Date.parse(query?.from ?? '')).toBe(30 * 86_400_000);

    await page.getByRole('tab', { name: ar.catalog.quickLinks.period['7'] }).click();
    await expect(page).toHaveURL(/days=7/);
    await expect.poll(() => admin.catalog.quickLinkQueries.length).toBe(2);

    admin.catalog.quickLinks = [];
    await page.getByRole('tab', { name: ar.catalog.quickLinks.period['90'] }).click();
    await expect(page.getByText(ar.catalog.quickLinks.empty)).toBeVisible();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the link card and the counts table', async ({ page, admin }, testInfo) => {
      const { game } = await scene(admin);
      await page.goto(`/catalog/games/${game.id}?tab=products`);
      await productRow(page, '660 شدة')
        .getByRole('button', { name: ar.catalog.quickLink.open })
        .click();
      await page.getByRole('dialog').getByLabel(ar.catalog.quickLink.campaign).fill('whatsapp');
      await screenshot(page, testInfo, `quick-link-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto(`/catalog/games/${game.id}`);
      await expect(page.getByRole('switch', { name: ar.catalog.game.bestValue })).toBeVisible();
      await screenshot(page, testInfo, `game-best-value-${colorScheme}`, { fullPage: true });

      await page.goto('/catalog/quick-links');
      await expect(page.getByRole('row')).toHaveCount(4);
      await screenshot(page, testInfo, `quick-links-${colorScheme}`, { fullPage: true });
    });
  });
}
