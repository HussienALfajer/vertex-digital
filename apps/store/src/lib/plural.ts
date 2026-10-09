import type { MessageKey } from './i18n';
import { t } from './i18n';

/*
 * Counts that agree with their number (brand/identity.md §10): a plural message has one leaf per
 * Arabic plural category (`zero`, `one`, `two`, `few`, `many`, `other`), chosen by the language's
 * own rules. `{count}` is filled with the number in Latin digits.
 */

const rules = new Intl.PluralRules('ar');

type PluralKey<Key extends string> = Key extends `${infer Base}.other` ? Base : never;

/** The message keys that have plural forms: `'units.seconds'` for `units.seconds.other`. */
export type PluralMessage = PluralKey<MessageKey>;

export function plural(key: PluralMessage, count: number): string {
  return t(`${key}.${rules.select(count)}` as MessageKey, { count });
}
