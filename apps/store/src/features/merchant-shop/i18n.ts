import messages from './messages.ar.json';

/*
 * "متجري"'s own Arabic catalog (S26 PR 4), apart from the merchant tools' and `messages/ar.json`:
 * only these pages import it. Same rules as `tm()`: a missing key is a type error.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type ShopAreaMessageKey = Leaves<typeof messages>;

export function tsa(key: ShopAreaMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
