import { PassThrough } from 'node:stream';
import type { DepositsReport, LedgerReport, ReportKind } from '@vertex-digital/contracts';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { writeReportWorkbook } from '../src/modules/reports/report-workbook.js';

/* The Excel writer alone (S13 rule X1): exact numbers of either sign. */

async function sheetOf(kind: ReportKind, report: LedgerReport | DepositsReport) {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  await writeReportWorkbook(stream, kind, report);
  const workbook = new ExcelJS.Workbook();
  // `exceljs` reads a Node buffer; its types name an older `Buffer`.
  await workbook.xlsx.load(
    Buffer.concat(chunks) as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('No sheet');
  return sheet;
}

async function cellsOf(report: LedgerReport): Promise<unknown[]> {
  const cells: unknown[] = [];
  (await sheetOf('ledger', report)).eachRow((row) =>
    row.eachCell((cell) => cells.push(cell.value)),
  );
  return cells;
}

describe('the report workbook', () => {
  it('writes negative pounds and dollars as exact numbers, never NaN', async () => {
    const cells = await cellsOf({
      from: '2026-10-01',
      to: '2026-10-01',
      generatedAt: '2026-10-11T10:00:00.000Z',
      rows: [
        {
          date: '2026-10-01',
          line: 'treasury_withdrawal',
          detail: null,
          usdUnits: -1_250_000,
          testUsdUnits: null,
        },
      ],
      totals: [],
      places: [
        { place: 'outside_syp', currency: 'SYP', startUnits: -1_234_550, endUnits: -5 },
        { place: 'outside_usd', currency: 'USD', startUnits: -3, endUnits: 0 },
      ],
      ownerDrawings: { startUnits: 0, endUnits: 20_000_000 },
    });
    expect(cells).toEqual(expect.arrayContaining([-12_345.5, -0.05, -1.25, -0.000003, 0, 20]));
    expect(cells.some((value) => typeof value === 'number' && Number.isNaN(value))).toBe(false);
  });

  it('formats each place in its currency, keeps manual deposits out of the totals and dates the export in Damascus (A09-19)', async () => {
    const ledger = await sheetOf('ledger', {
      from: '2026-10-01',
      to: '2026-10-01',
      generatedAt: '2026-10-11T22:30:00.000Z',
      rows: [],
      totals: [],
      places: [
        { place: 'sham_cash_syp', currency: 'SYP', startUnits: 0, endUnits: 1_000_000 },
        { place: 'usdt_trc20', currency: 'USD', startUnits: 0, endUnits: 2_500_000 },
      ],
      ownerDrawings: { startUnits: 0, endUnits: 0 },
    });
    const formats = new Map<unknown, string | undefined>();
    ledger.eachRow((row) =>
      row.eachCell((cell) => {
        if (typeof cell.value === 'number' && cell.value !== 0)
          formats.set(cell.value, cell.numFmt);
      }),
    );
    expect(formats.get(10_000)).toBe('#,##0');
    expect(formats.get(2.5)).toBe('$#,##0.00');
    // 22:30 UTC is 01:30 the next day in Damascus.
    expect(String(ledger.getRow(1).getCell(2).value)).toContain('2026-10-12 01:30');
    const deposits = await sheetOf('deposits', {
      from: '2026-10-01',
      to: '2026-10-01',
      generatedAt: '2026-10-11T10:00:00.000Z',
      rows: [
        {
          method: 'sham_cash',
          credited: 2,
          creditedUsdUnits: 30_000_000,
          receivedSypUnits: null,
          rejected: 0,
          expired: 0,
          medianReviewMinutes: null,
        },
      ],
      totals: { credited: 2, creditedUsdUnits: 30_000_000, rejected: 0, expired: 0 },
      manualDeposits: { count: 1, usdUnits: 5_000_000 },
    } as DepositsReport);
    const values: unknown[][] = [];
    deposits.eachRow((row) => values.push(row.values as unknown[]));
    const totals = values.findIndex((row) => row.includes('الإجمالي'));
    const manual = values.findIndex((row) => row.includes(5));
    // The manual line comes after the totals row, in a block of its own.
    expect(manual).toBeGreaterThan(totals);
  });
});
