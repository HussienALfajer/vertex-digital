/**
 * Rule SF2: a pack shows its in-game amount. Most names already carry it ("60 شدة", "1,800 شدة"),
 * so it is shown on its own line only when the name does not ("800 + 160 نقطة CP" gives 960,
 * "الباقة الأساسية" gives 60; audit A9). A single unit ("برايم شهر واحد") shows none (2026-10-19).
 * Latin digits with thousands separators.
 */
export function packAmountText(nameAr: string, gameAmount: number | null): string | null {
  if (gameAmount === null || gameAmount <= 1) return null;
  const digits = nameAr.replace(/[,\s]/g, '');
  if (digits.includes(String(gameAmount))) return null;
  return gameAmount.toLocaleString('en-US');
}
