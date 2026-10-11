import type { Writable } from 'node:stream';
import {
  type BreakdownReport,
  CURRENCY_SCALE,
  type CustomersReport,
  type DepositsReport,
  type LedgerReport,
  type RefundsReport,
  type Report,
  type ReportKind,
  type SalesReport,
} from '@vertex-digital/contracts';
import ExcelJS from 'exceljs';

/*
 * The Excel export of a report (S13 rules X1–X3): one right-to-left sheet with Arabic headers, a
 * title row with the period and the export time, the totals computed on the server, money as
 * numbers with a dollar format. Every text cell is a plain string, never a formula, whatever it
 * starts with (rule X2). Never a phone number, player id, address or code (rule X3).
 */

type Cell = string | number | Date | null;

interface Column {
  header: string;
  width: number;
  format?: 'usd' | 'syp' | 'percent' | 'date' | 'count';
}

const USD_FORMAT = '$#,##0.00';
const SYP_FORMAT = '#,##0';
const FORMATS = {
  usd: USD_FORMAT,
  syp: SYP_FORMAT,
  percent: '0.0',
  date: 'yyyy-mm-dd',
  count: '#,##0',
} as const;

/** USD units as a number of dollars, from the exact decimal (no float arithmetic on units). */
function usd(units: number): number {
  const sign = units < 0 ? '-' : '';
  const magnitude = Math.abs(units);
  const scale = CURRENCY_SCALE.USD;
  const whole = Math.floor(magnitude / scale);
  const fraction = String(magnitude % scale).padStart(6, '0');
  return Number(`${sign}${whole}.${fraction}`);
}

/** SYP units as a number of pounds, from the exact decimal. */
function syp(units: number): number {
  const scale = CURRENCY_SCALE.SYP;
  return Number(`${Math.floor(units / scale)}.${String(units % scale).padStart(2, '0')}`);
}

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

const METHODS: Record<string, string> = {
  sham_cash: 'شام كاش',
  usdt_trc20: 'USDT (TRC20)',
  usdt_bep20: 'USDT (BEP20)',
};
const REFUND_REASONS: Record<string, string> = {
  no_route: 'لا مسار متاح',
  routes_exhausted: 'فشلت كل المسارات',
  input_rejected: 'بيانات الحساب مرفوضة',
  admin: 'قرار الإدارة',
};
const LEDGER_LINES: Record<string, string> = {
  deposit: 'إيداعات مقيدة',
  purchase: 'مشتريات',
  refund: 'مبالغ معادة',
  cost_of_goods: 'تكلفة البضاعة',
  adjustment_credit: 'تعديلات إضافة',
  adjustment_debit: 'تعديلات خصم',
  treasury_funding: 'تمويل الموردين',
  treasury_withdrawal: 'سحوبات',
  treasury_injection: 'أموال أُدخلت',
  treasury_transfer: 'تحويلات بين الأماكن',
  transfer_fee: 'رسوم التحويل',
  supplier_correction: 'تصحيحات الموردين',
  rounding_gain: 'كسور الإيداع',
};
const CATEGORIES: Record<string, string> = {
  compensation: 'تعويض',
  correction: 'تصحيح',
  cash_refund: 'استرداد نقدي',
  manual_deposit: 'إيداع يدوي',
  test_funds: 'رصيد تجريبي',
};
const PLACES: Record<string, string> = {
  sham_cash_syp: 'شام كاش (ل.س)',
  sham_cash_usd: 'شام كاش (دولار)',
  usdt_trc20: 'USDT (TRC20)',
  usdt_bep20: 'USDT (BEP20)',
  'supplier:shop2topup': 'SHOP2TOPUP',
  'supplier:wdgzone': 'WDGZone',
  'supplier:manual': 'المورد اليدوي',
  'supplier:fake': 'المورد التجريبي',
  outside_usd: 'خارج المتجر (دولار)',
  outside_syp: 'خارج المتجر (ل.س)',
};
const TITLES: Record<ReportKind, string> = {
  sales: 'المبيعات والأرباح',
  breakdown: 'تفصيل المبيعات',
  deposits: 'الإيداعات',
  refunds: 'الاستردادات والإخفاقات',
  customers: 'أفضل العملاء',
  ledger: 'حركة المال',
};

const label = (labels: Record<string, string>, value: string | null) =>
  value === null ? '' : (labels[value] ?? value);

interface Block {
  columns: Column[];
  rows: Cell[][];
  totals?: Cell[];
}

function blocks(kind: ReportKind, report: Report<ReportKind>): Block[] {
  switch (kind) {
    case 'sales': {
      const sales = report as SalesReport;
      const figures = (row: SalesReport['totals']): Cell[] => [
        row.delivered,
        usd(row.salesUsdUnits),
        usd(row.costUsdUnits),
        usd(row.profitUsdUnits),
        row.marginPercent,
      ];
      return [
        {
          columns: [
            { header: 'التاريخ', width: 14, format: 'date' },
            { header: 'الطلبات المسلّمة', width: 16, format: 'count' },
            { header: 'المبيعات', width: 16, format: 'usd' },
            { header: 'التكلفة', width: 16, format: 'usd' },
            { header: 'الربح', width: 16, format: 'usd' },
            { header: 'الهامش %', width: 12, format: 'percent' },
          ],
          rows: sales.rows.map((row) => [date(row.date), ...figures(row)]),
          totals: ['الإجمالي', ...figures(sales.totals)],
        },
      ];
    }
    case 'breakdown': {
      const breakdown = report as BreakdownReport;
      const bySupplier = breakdown.by === 'supplier';
      const figures = (row: BreakdownReport['totals']): Cell[] => [
        row.delivered,
        row.deliveredUnits,
        usd(row.salesUsdUnits),
        usd(row.costUsdUnits),
        usd(row.profitUsdUnits),
        row.marginPercent,
        ...(bySupplier ? [row.attemptsSent, row.attemptsFailed, row.failureRatePercent] : []),
      ];
      return [
        {
          columns: [
            {
              header: bySupplier ? 'المورد' : breakdown.by === 'game' ? 'اللعبة' : 'المنتج',
              width: 28,
            },
            ...(breakdown.by === 'product' ? [{ header: 'اللعبة', width: 22 }] : []),
            { header: 'الطلبات المسلّمة', width: 16, format: 'count' as const },
            { header: 'الوحدات', width: 12, format: 'count' as const },
            { header: 'المبيعات', width: 16, format: 'usd' as const },
            { header: 'التكلفة', width: 16, format: 'usd' as const },
            { header: 'الربح', width: 16, format: 'usd' as const },
            { header: 'الهامش %', width: 12, format: 'percent' as const },
            ...(bySupplier
              ? [
                  { header: 'محاولات مرسلة', width: 14, format: 'count' as const },
                  { header: 'محاولات فاشلة', width: 14, format: 'count' as const },
                  { header: 'نسبة الفشل %', width: 14, format: 'percent' as const },
                ]
              : []),
          ],
          rows: breakdown.rows.map((row) => [
            row.nameAr,
            ...(breakdown.by === 'product' ? [row.gameNameAr ?? ''] : []),
            ...figures(row),
          ]),
          totals: [
            'الإجمالي',
            ...(breakdown.by === 'product' ? [''] : []),
            ...figures(breakdown.totals),
          ],
        },
      ];
    }
    case 'deposits': {
      const deposits = report as DepositsReport;
      return [
        {
          columns: [
            { header: 'الطريقة', width: 18 },
            { header: 'المقبولة', width: 12, format: 'count' },
            { header: 'المبلغ المقيد', width: 16, format: 'usd' },
            { header: 'الليرات المستلمة', width: 18, format: 'syp' },
            { header: 'المرفوضة', width: 12, format: 'count' },
            { header: 'المنتهية', width: 12, format: 'count' },
            { header: 'وسيط المراجعة (دقيقة)', width: 20, format: 'percent' },
          ],
          rows: [
            ...deposits.rows.map((row): Cell[] => [
              label(METHODS, row.method),
              row.credited,
              usd(row.creditedUsdUnits),
              row.receivedSypUnits === null ? null : syp(row.receivedSypUnits),
              row.rejected,
              row.expired,
              row.medianReviewMinutes,
            ]),
            [
              'إيداعات يدوية',
              deposits.manualDeposits.count,
              usd(deposits.manualDeposits.usdUnits),
              null,
              null,
              null,
              null,
            ],
          ],
          totals: [
            'الإجمالي',
            deposits.totals.credited,
            usd(deposits.totals.creditedUsdUnits),
            null,
            deposits.totals.rejected,
            deposits.totals.expired,
            null,
          ],
        },
      ];
    }
    case 'refunds': {
      const refunds = report as RefundsReport;
      return [
        {
          columns: [
            { header: 'سبب الاسترداد', width: 26 },
            { header: 'الطلبات', width: 12, format: 'count' },
            { header: 'المبلغ', width: 16, format: 'usd' },
          ],
          rows: refunds.byReason.map((row) => [
            label(REFUND_REASONS, row.reason),
            row.orders,
            usd(row.usdUnits),
          ]),
          totals: ['الإجمالي', refunds.totals.orders, usd(refunds.totals.usdUnits)],
        },
        {
          columns: [
            { header: 'المنتج', width: 26 },
            { header: 'اللعبة', width: 22 },
            { header: 'الطلبات المنتهية', width: 16, format: 'count' },
            { header: 'المستردة', width: 12, format: 'count' },
            { header: 'نسبة الاسترداد %', width: 16, format: 'percent' },
          ],
          rows: refunds.products.map((row) => [
            row.nameAr,
            row.gameNameAr,
            row.finished,
            row.refunded,
            row.refundRatePercent,
          ]),
        },
        {
          columns: [
            { header: 'المورد', width: 22 },
            { header: 'المحاولات المنتهية', width: 18, format: 'count' },
            { header: 'الفاشلة', width: 12, format: 'count' },
            { header: 'نسبة الفشل %', width: 14, format: 'percent' },
          ],
          rows: refunds.suppliers.map((row) => [
            row.nameAr,
            row.resolved,
            row.failed,
            row.failureRatePercent,
          ]),
        },
      ];
    }
    case 'customers': {
      const customers = report as CustomersReport;
      return [
        {
          columns: [
            { header: 'الاسم', width: 24 },
            { header: 'البريد الإلكتروني', width: 30 },
            { header: 'الطلبات المسلّمة', width: 16, format: 'count' },
            { header: 'المبيعات', width: 16, format: 'usd' },
            { header: 'الربح', width: 16, format: 'usd' },
            { header: 'الإيداعات', width: 16, format: 'usd' },
          ],
          rows: customers.rows.map((row) => [
            row.name,
            row.email,
            row.delivered,
            usd(row.salesUsdUnits),
            usd(row.profitUsdUnits),
            usd(row.depositsUsdUnits),
          ]),
          totals: [
            'الإجمالي',
            '',
            customers.totals.delivered,
            usd(customers.totals.salesUsdUnits),
            usd(customers.totals.profitUsdUnits),
            usd(customers.totals.depositsUsdUnits),
          ],
        },
      ];
    }
    case 'ledger': {
      const ledger = report as LedgerReport;
      const detail = (value: string | null) => label({ ...METHODS, ...CATEGORIES }, value);
      return [
        {
          columns: [
            { header: 'التاريخ', width: 14, format: 'date' },
            { header: 'البند', width: 24 },
            { header: 'التفصيل', width: 18 },
            { header: 'المبلغ', width: 16, format: 'usd' },
            { header: 'حصة العملاء التجريبيين', width: 22, format: 'usd' },
          ],
          rows: ledger.rows.map((row) => [
            date(row.date),
            label(LEDGER_LINES, row.line),
            detail(row.detail),
            usd(row.usdUnits),
            row.testUsdUnits === null ? null : usd(row.testUsdUnits),
          ]),
        },
        {
          columns: [
            { header: 'الإجمالي حسب البند', width: 24 },
            { header: 'التفصيل', width: 18 },
            { header: 'المبلغ', width: 16, format: 'usd' },
            { header: 'حصة العملاء التجريبيين', width: 22, format: 'usd' },
          ],
          rows: ledger.totals.map((row) => [
            label(LEDGER_LINES, row.line),
            detail(row.detail),
            usd(row.usdUnits),
            row.testUsdUnits === null ? null : usd(row.testUsdUnits),
          ]),
        },
        {
          columns: [
            { header: 'المكان', width: 24 },
            { header: 'في البداية', width: 16 },
            { header: 'في النهاية', width: 16 },
          ],
          rows: ledger.places.map((row) => {
            const value = row.currency === 'USD' ? usd : syp;
            return [label(PLACES, row.place), value(row.startUnits), value(row.endUnits)];
          }),
        },
      ];
    }
  }
}

/** The number of data rows, for the audit entry (rule X4). */
export function reportRowCount(kind: ReportKind, report: Report<ReportKind>): number {
  return blocks(kind, report).reduce((total, block) => total + block.rows.length, 0);
}

/** `vertex-<report>-<from>-<to>.xlsx` (rule X3). */
export function reportFileName(kind: ReportKind, from: string, to: string): string {
  return `vertex-${kind}-${from}-${to}.xlsx`;
}

/** Streams the workbook to `stream` (rule X1). */
export async function writeReportWorkbook(
  stream: Writable,
  kind: ReportKind,
  report: Report<ReportKind>,
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  const sheet = workbook.addWorksheet(TITLES[kind], { views: [{ rightToLeft: true }] });
  const parts = blocks(kind, report);
  const width = Math.max(...parts.map((block) => block.columns.length));
  sheet.columns = Array.from({ length: width }, (_, index) => ({
    width: Math.max(...blocks(kind, report).map((block) => block.columns[index]?.width ?? 0), 10),
  }));
  const title = sheet.addRow([
    `${TITLES[kind]}: ${report.from} إلى ${report.to}`,
    `صُدّر في ${report.generatedAt.slice(0, 16).replace('T', ' ')} UTC`,
  ]);
  title.font = { bold: true, size: 13 };
  title.commit();
  for (const block of parts) {
    sheet.addRow([]).commit();
    const header = sheet.addRow(block.columns.map((column) => column.header));
    header.font = { bold: true };
    header.commit();
    const add = (cells: Cell[], bold = false) => {
      const row = sheet.addRow(cells);
      cells.forEach((value, index) => {
        const format = block.columns[index]?.format;
        // Rule X2: text is written as a string cell, which Excel never reads as a formula
        // (`exceljs` writes a formula only from a `{ formula }` value).
        if (typeof value !== 'string' && format && value !== null) {
          row.getCell(index + 1).numFmt = FORMATS[format];
        }
      });
      if (bold) row.font = { bold: true };
      row.commit();
    };
    for (const cells of block.rows) add(cells);
    if (block.totals) add(block.totals, true);
  }
  sheet.commit();
  await workbook.commit();
}
