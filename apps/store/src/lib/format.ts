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
