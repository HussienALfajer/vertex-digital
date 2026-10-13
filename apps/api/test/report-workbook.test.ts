import { PassThrough } from 'node:stream';
import type { LedgerReport } from '@vertex-digital/contracts';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { writeReportWorkbook } from '../src/modules/reports/report-workbook.js';

/* The Excel writer alone (S13 rule X1): exact numbers of either sign. */

async function cellsOf(report: LedgerReport): Promise<unknown[]> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  await writeReportWorkbook(stream, 'ledger', report);
  const workbook = new ExcelJS.Workbook();
  // `exceljs` reads a Node buffer; its types name an older `Buffer`.
  await workbook.xlsx.load(
    Buffer.concat(chunks) as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const cells: unknown[] = [];
  workbook.worksheets[0]?.eachRow((row) => row.eachCell((cell) => cells.push(cell.value)));
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
});
