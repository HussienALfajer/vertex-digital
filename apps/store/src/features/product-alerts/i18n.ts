import messages from './messages.ar.json';

/*
 * The product alerts' own Arabic catalog (S22 F42: the alert buttons and "تنبيهاتي"), apart from
 * `messages/ar.json`, which every page ships in its first load: only the alert button, loaded with
 * `next/dynamic` on the game page, and the alerts page import it. Same rules as `t()`.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type ProductAlertsMessageKey = Leaves<typeof messages>;

export function ta(key: ProductAlertsMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
