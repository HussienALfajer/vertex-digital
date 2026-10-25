import messages from './messages.ar.json';

/*
 * The order help's own Arabic catalog (S22 F41: the problem card, its hints and the form), apart
 * from `messages/ar.json`, which every page ships in its first load: only the card and the sheet,
 * loaded with `next/dynamic` on the order page, import it. Same rules as `t()`.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type OrderHelpMessageKey = Leaves<typeof messages>;

export function th(key: OrderHelpMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
