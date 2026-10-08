/*
 * Dates in Arabic with Latin digits (brand/identity.md), in the viewer's time zone. Only in the
 * browser: the server's zone is not the customer's.
 */

const LOCALE = 'ar-u-nu-latn';

const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long' });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return date.format(new Date(iso));
}

/**
 * Text that reads left to right (`$25.00`, `+5.08%`) kept whole inside an Arabic sentence: wrapped
 * in an LTR isolate (U+2066 … U+2069), so the bidi algorithm never splits it.
 */
export const ltr = (text: string) => `⁦${text}⁩`;

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/** The largest unit that fits, in seconds. */
const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
];

/** "قبل 5 دقائق", "أمس": up to a week; older times show their date. */
export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const elapsed = Math.abs(seconds);
  if (elapsed >= 7 * 24 * 60 * 60) return formatDate(iso);
  for (const [unit, size] of RELATIVE_STEPS)
    if (elapsed >= size) return relative.format(Math.trunc(seconds / size), unit);
  return relative.format(0, 'minute');
}
