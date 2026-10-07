import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/min';

export type { CountryCode };

/** Most customers are in Syria: the picker starts there (S01 screens). */
export const DEFAULT_COUNTRY: CountryCode = 'SY';

export interface CountryOption {
  code: CountryCode;
  name: string;
  /** `+963` */
  dialCode: string;
}

/** Every country with its Arabic name (from the browser) and dialling code, Syria first. */
export function countryOptions(locale = 'ar'): CountryOption[] {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  const options = getCountries().map((code) => ({
    code,
    name: names.of(code) ?? code,
    dialCode: `+${getCountryCallingCode(code)}`,
  }));
  options.sort((a, b) =>
    a.code === DEFAULT_COUNTRY
      ? -1
      : b.code === DEFAULT_COUNTRY
        ? 1
        : a.name.localeCompare(b.name, locale),
  );
  return options;
}

/**
 * The number as E.164 (`+963944123456`), or null when it is not a valid number. A number written
 * with its country code (`+…` or `00…`) keeps it; a local one (`0944…`) belongs to `country`.
 * Spaces, dashes, dots and brackets are ignored (edge case 14).
 */
export function toE164(typed: string, country: CountryCode): string | null {
  const compact = typed.replace(/[\s\-().]/g, '').replace(/^00/, '+');
  if (!compact) return null;
  const parsed = parsePhoneNumberFromString(compact, compact.startsWith('+') ? undefined : country);
  return parsed?.isValid() ? parsed.number : null;
}

/** An E.164 number as people read it: `+963 944 123 456`. */
export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}

/** The country of an E.164 number, for the picker when an existing number is edited. */
export function countryOf(e164: string): CountryCode {
  return parsePhoneNumberFromString(e164)?.country ?? DEFAULT_COUNTRY;
}

/** The number as typed in its country (`0944 123 456`), for editing an existing number. */
export function nationalPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatNational() ?? e164;
}
