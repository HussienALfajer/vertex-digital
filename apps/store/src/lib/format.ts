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
