import type { OrderPrint } from '@vertex-digital/contracts';
import ExcelJS from 'exceljs';

/*
 * The Excel export of an order's codes (S21 CR2): one right-to-left sheet, a row per code with the
 * order number, the pack, its position, the code and the redemption steps. Every cell is a plain
 * string, never a formula, whatever it starts with (`exceljs` writes a formula only from a
 * `{ formula }` value; S13 rule X2).
 */

/** `codes-<order number>.xlsx`: the order number only (CR2). */
export function codesFileName(orderNumber: string): string {
  return `codes-${orderNumber}.xlsx`;
}

export async function codesWorkbook(
  order: Pick<OrderPrint, 'orderNumber' | 'product'>,
  codes: readonly { position: number; code: string }[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الأكواد', { views: [{ rightToLeft: true }] });
  sheet.columns = [
    { header: 'رقم الطلب', width: 16 },
    { header: 'الباقة', width: 28 },
    { header: 'الرقم', width: 8 },
    { header: 'الكود', width: 32 },
    { header: 'طريقة الاستخدام', width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const code of codes) {
    sheet.addRow([
      order.orderNumber,
      order.product.nameAr,
      String(code.position),
      code.code,
      order.product.redemptionAr ?? '',
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
