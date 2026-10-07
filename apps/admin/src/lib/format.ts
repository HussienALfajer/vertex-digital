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
