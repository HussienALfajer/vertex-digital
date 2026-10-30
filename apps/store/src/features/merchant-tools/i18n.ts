import messages from './messages.ar.json';

/*
 * The merchant area's own Arabic catalog (S21), apart from `messages/ar.json`, which every page
 * ships in its first load: only the merchant pages import it, so the store's other pages keep
 * their budgets (`e2e/store.spec.ts`). Same rules as `t()`: a missing key is a type error.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MerchantMessageKey = Leaves<typeof messages>;

export function tm(key: MerchantMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** A key of the merchant catalog whose value holds a count's forms (`one`, `few`, `other`…). */
export type MerchantCountKey = MerchantMessageKey extends infer Key
  ? Key extends `${infer Base}.other`
    ? Base
    : never
  : never;

const plurals = new Intl.PluralRules('ar');

/** A count in words that agree with it (brand/identity.md §10), as `tc` in `lib/i18n.ts`. */
export function tmc(
  key: MerchantCountKey,
  count: number,
  values?: Record<string, string | number>,
): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const form = plurals.select(count);
  const forms = node as Record<string, string>;
  return tm(`${key}.${form in forms ? form : 'other'}` as MerchantMessageKey, { count, ...values });
}
