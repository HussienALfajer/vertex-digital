/*
 * Dates in Arabic with Latin digits (brand/identity.md), in the viewer's time zone (rule A4).
 */

const LOCALE = 'ar-u-nu-latn';

const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });
const exact = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeStyle: 'medium' });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

export const formatDate = (iso: string) => date.format(new Date(iso));

/** To the second, for the audit entry's detail. */
export const formatExactTime = (iso: string) => exact.format(new Date(iso));

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/**
 * How long ago `iso` was, in the largest whole unit: "منذ 12 دقيقة", "منذ 3 ساعات". Arabic plural
 * forms come from `Intl`. Under a minute reads as "now".
 */
export function formatSince(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return relative.format(-hours, 'hour');
  return relative.format(-Math.floor(hours / 24), 'day');
}

/**
 * Text that reads left to right (`$25.00`, `+5.08%`) kept whole inside an Arabic sentence: wrapped
 * in an LTR isolate (U+2066 … U+2069), so the bidi algorithm never splits it.
 */
export const ltr = (text: string) => `⁦${text}⁩`;
