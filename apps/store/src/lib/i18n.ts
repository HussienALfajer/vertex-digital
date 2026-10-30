import ar from '../messages/ar.json';

/** `'signIn.title'` for every string leaf of the catalog. */
type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof ar>;

/**
 * The Arabic catalog (ADR 0012: Arabic only in V1). Works in server and client components:
 * `t('signIn.title')`, with `{name}` placeholders filled from `values`. A missing key is a type
 * error.
 */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  let node: unknown = ar;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** A key of the catalog whose value holds a count's forms (`one`, `two`, `few`, `many`, `other`). */
export type CountKey = MessageKey extends infer Key
  ? Key extends `${infer Base}.other`
    ? Base
    : never
  : never;

const plurals = new Intl.PluralRules('ar');

/**
 * A count in words that agree with it (brand/identity.md §10): `tc('catalog.itemCount', 147)` is
 * "147 عنصرًا". The form follows Arabic's plural rules, `other` where the catalog has no own form.
 */
export function tc(key: CountKey, count: number, values?: Record<string, string | number>): string {
  const forms = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], ar) as Record<
    string,
    string
  >;
  const form = plurals.select(count);
  return t(`${key}.${form in forms ? form : 'other'}` as MessageKey, { count, ...values });
}
