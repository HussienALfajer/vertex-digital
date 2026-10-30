import {
  CURRENCY_SCALE,
  formatRate,
  formatSyp,
  type JournalKind,
  REVIEW_TIME_ZONE,
  type Statement,
  type StatementEntry,
  type StatementOrder,
  TIER_NAMES_AR,
} from '@vertex-digital/contracts';
import ExcelJS from 'exceljs';

/*
 * The Excel export of a merchant's statement (S21 ST3): two right-to-left sheets, "الملخص" and
 * "الحركات", amounts as numbers of dollars with two decimals. Every text cell is a plain string,
 * never a formula, whatever it starts with (`exceljs` writes a formula only from a `{ formula }`
 * value; S13 rule X2). The merchant's own statement carries the full player IDs (ST2).
 */

const USD_FORMAT = '$#,##0.00';

/**
 * Abuse table: a text cell never starts with `=`, `+`, `-`, `@`, a tab or a return unescaped,
 * so a sheet saved as CSV or edited again never runs one as a formula.
 */
export function safeText(value: string): string {
  return /^[-=+@\t\r]/.test(value) ? `'${value}` : value;
}

/** USD units as a number of dollars, from the exact decimal (as `report-workbook.ts`). */
function usd(units: number): number {
  const sign = units < 0 ? '-' : '';
  const magnitude = Math.abs(units);
  const scale = CURRENCY_SCALE.USD;
  const whole = Math.floor(magnitude / scale);
  const fraction = String(magnitude % scale).padStart(6, '0');
  return Number(`${sign}${whole}.${fraction}`);
}

const KIND_LABELS: Record<JournalKind, string> = {
  deposit: 'إيداع',
  purchase: 'شراء',
  refund: 'استرداد',
  cost_of_goods: 'تكلفة',
  adjustment: 'تعديل',
  treasury: 'خزينة',
};

const METHODS: Record<string, string> = {
  sham_cash: 'شام كاش',
  usdt_trc20: 'USDT (TRC20)',
  usdt_bep20: 'USDT (BEP20)',
};

const CATEGORIES: Record<string, string> = {
  compensation: 'تعويض',
  correction: 'تصحيح',
  cash_refund: 'استرداد نقدي',
  manual_deposit: 'إيداع يدوي',
  test_funds: 'رصيد تجريبي',
};

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: REVIEW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `2026-10-21 14:05`, Damascus time. */
function damascusTime(iso: string): string {
  const parts = Object.fromEntries(
    dateTime.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function orderText(order: StatementOrder): string {
  const fields = order.fields.map((field) => `${field.labelAr}: ${field.value}`).join('، ');
  return [
    `طلب ${order.number}`,
    `${order.productNameAr} × ${order.quantity}`,
    order.gameNameAr,
    fields,
  ]
    .filter((part) => part.length > 0)
    .join(' · ');
}

/** ST2: what an entry was, as the statement page shows it. */
export function entryDetails(entry: StatementEntry): string {
  if (entry.deposit) {
    const { method, referenceCode, syp } = entry.deposit;
    const pounds = syp ? ` · ${formatSyp(syp.amountUnits)} ل.س بسعر ${formatRate(syp.rate)}` : '';
    return `${METHODS[method] ?? method} · المرجع ${referenceCode}${pounds}`;
  }
  if (entry.checkout) return entry.checkout.orders.map(orderText).join(' | ');
  if (entry.order) return orderText(entry.order);
  if (entry.adjustment) {
    const category = CATEGORIES[entry.adjustment.category] ?? entry.adjustment.category;
    const reversal = entry.adjustment.reversal ? ' (عكس تعديل سابق)' : '';
    const note = entry.adjustment.customerNote ? ` · ${entry.adjustment.customerNote}` : '';
    return `${category}${reversal}${note}`;
  }
  return '';
}

/** `statement-<month>.xlsx`: the month only (ST3). */
export function statementFileName(month: string): string {
  return `statement-${month}.xlsx`;
}

export async function statementWorkbook(statement: Statement): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('الملخص', { views: [{ rightToLeft: true }] });
  summary.columns = [{ width: 28 }, { width: 36 }];
  const line = (label: string, value: string | number, money = false) => {
    const row = summary.addRow([label, typeof value === 'string' ? safeText(value) : value]);
    if (money) row.getCell(2).numFmt = USD_FORMAT;
  };
  summary.addRow(['كشف حساب']).font = { bold: true, size: 14 };
  line('المتجر', statement.tradeName);
  line('البريد الإلكتروني', statement.email);
  line('الشهر', statement.current ? `${statement.month} (حتى تاريخه)` : statement.month);
  line('أُنشئ في', damascusTime(statement.generatedAt));
  line('الرصيد الافتتاحي', usd(statement.openingUsdUnits), true);
  for (const total of statement.totals) {
    line(`${KIND_LABELS[total.kind]} (${total.count})`, usd(total.amountUnits), true);
  }
  line('الرصيد الختامي', usd(statement.closingUsdUnits), true);
  // S23 ID9: the tier held that month.
  if (statement.tier) {
    const { tier, netPurchasesUsdUnits, savingsUsdUnits, next } = statement.tier;
    summary.addRow([]);
    summary.addRow(['فئتك هذا الشهر']).font = { bold: true };
    line('الفئة', tier === 'bronze' ? 'تاجر معتمد' : `تاجر ${TIER_NAMES_AR[tier]} معتمد`);
    line('صافي المشتريات', usd(netPurchasesUsdUnits), true);
    if (savingsUsdUnits !== null) line('وفّرت فئتك', usd(savingsUsdUnits), true);
    if (next) line(`الباقي للفئة ال${TIER_NAMES_AR[next.tier]}ة`, usd(next.missingUsdUnits), true);
  }

  const entries = workbook.addWorksheet('الحركات', { views: [{ rightToLeft: true }] });
  entries.columns = [
    { header: 'التاريخ', width: 18 },
    { header: 'النوع', width: 12 },
    { header: 'التفاصيل', width: 70 },
    { header: 'المبلغ', width: 14, style: { numFmt: USD_FORMAT } },
    { header: 'الرصيد بعدها', width: 14, style: { numFmt: USD_FORMAT } },
  ];
  entries.getRow(1).font = { bold: true };
  for (const entry of statement.entries) {
    entries.addRow([
      damascusTime(entry.occurredAt),
      KIND_LABELS[entry.kind],
      safeText(entryDetails(entry)),
      usd(entry.amountUnits),
      usd(entry.balanceAfterUnits),
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
