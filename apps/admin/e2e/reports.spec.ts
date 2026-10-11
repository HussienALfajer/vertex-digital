import type { BreakdownReport, Report, ReportKind, SalesReport } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, screenshot, test, USD } from './test';

/*
 * Reports (S13, F22): R1 with its daily lines, totals and sorting, R2 by supplier, an empty
 * period, a custom period in the URL and the Excel export, against the mocked API.
 */

const rp = ar.reports;
const ltr = (text: string) => `⁦${text}⁩`;

const figures = (delivered: number, sales: number, cost: number) => ({
  delivered,
  salesUsdUnits: sales,
  costUsdUnits: cost,
  profitUsdUnits: sales - cost,
  marginPercent: Math.round(((sales - cost) * 1000) / sales) / 10,
});

function sales(from: string, to: string): Report<ReportKind> {
  const report: SalesReport = {
    from,
    to,
    generatedAt: new Date().toISOString(),
    rows: [
      { date: from, ...figures(3, 12 * USD, 10_345_600) },
      { date: to, ...figures(5, 30 * USD, 25_100_000) },
    ],
    totals: figures(8, 42 * USD, 35_445_600),
  };
  return report;
}

function bySupplier(from: string, to: string): Report<ReportKind> {
  const attempts = { attemptsSent: 6, attemptsFailed: 1, failureRatePercent: 16.7 };
  const report: BreakdownReport = {
    from,
    to,
    generatedAt: new Date().toISOString(),
    by: 'supplier',
    rows: [
      {
        key: 'fake',
        nameAr: 'مورد تجريبي',
        gameNameAr: null,
        gameId: null,
        supplier: 'fake',
        ...figures(5, 30 * USD, 25_100_000),
        deliveredUnits: 5,
        ...attempts,
      },
    ],
    totals: { ...figures(5, 30 * USD, 25_100_000), deliveredUnits: 5, ...attempts },
  };
  return report;
}

async function open(page: import('@playwright/test').Page, admin: AdminApi, path = '/reports') {
  admin.signedIn = true;
  admin.reconciliation.reports.sales = sales;
  admin.reconciliation.reports.breakdown = bySupplier;
  await page.goto(path);
}

test('R1: the daily lines, the rows and their totals rounded to the cent; sorted on click', async ({
  page,
  admin,
}) => {
  await open(page, admin);
  await expect(page.getByRole('img', { name: rp.sales.salesLine })).toBeVisible();
  const table = page.getByRole('table', { name: rp.kinds.sales });
  const totals = table.getByRole('row').last();
  await expect(totals).toContainText(rp.totals);
  await expect(totals).toContainText(ltr('$42.00'));
  // The cost keeps sub-cent precision in the data and shows rounded half-up (rule RP9).
  await expect(totals).toContainText(ltr('$35.45'));
  await expect(totals).toContainText(ltr('15.6%'));
  await table.getByRole('button', { name: rp.columns.sales }).click();
  await expect(table.getByRole('row').nth(1)).toContainText(ltr('$30.00'));
  await table.getByRole('button', { name: rp.columns.sales }).click();
  await expect(table.getByRole('row').nth(1)).toContainText(ltr('$12.00'));
});

test('R2 by supplier keeps the breakdown and period in the URL', async ({ page, admin }) => {
  await open(page, admin, '/reports?kind=breakdown&from=2026-09-15&to=2026-10-11');
  await page
    .getByRole('group', { name: rp.breakdown.label })
    .getByRole('button', { name: rp.breakdown.by.supplier })
    .click();
  await expect(page).toHaveURL(/by=supplier/);
  await expect(page.getByRole('link', { name: 'مورد تجريبي' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: rp.columns.failureRate })).toBeVisible();
  expect(admin.calls).toContain('GET /api/admin/reports/breakdown');
  await expect(page.getByRole('combobox', { name: rp.period.label })).toHaveText(rp.presets.custom);
});

test('an empty period says so; the export downloads the report', async ({ page, admin }) => {
  await open(page, admin, '/reports?kind=deposits');
  await expect(page.getByText(rp.empty)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: rp.export }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^vertex-deposits-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx$/,
  );
});

// RTL screenshots of the S13 reports in both themes (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S13 reports screenshots', async ({ page, admin }, testInfo) => {
      await open(page, admin);
      await expect(page.getByRole('table', { name: rp.kinds.sales })).toBeVisible();
      await screenshot(page, testInfo, `reports-sales-${colorScheme}`, { fullPage: true });
      await page.goto('/reports?kind=breakdown&by=supplier');
      await expect(page.getByRole('link', { name: 'مورد تجريبي' })).toBeVisible();
      await screenshot(page, testInfo, `reports-supplier-${colorScheme}`, { fullPage: true });
    });
  });
}
