import messages from './messages.ar.json';

/*
 * The order page's own small Arabic catalog (S21 F35: the verification QR and the branded receipt
 * link), apart from `messages/ar.json`, which every page ships in its first load, and from the
 * merchant catalog, which only the merchant pages should ship (audit A06-14). Same rules as `t()`.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type OrderMessageKey = Leaves<typeof messages>;

export function to(key: OrderMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
