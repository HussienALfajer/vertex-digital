import messages from './messages.ar.json';

/*
 * A merchant shop's own Arabic catalog (S26): only the `/s/[slug]` pages ship it, apart from
 * `messages/ar.json`, which every store page ships. Same rules as `t()`; the shared field labels
 * and error texts still come from `t()` and `errorText()`.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type ShopMessageKey = Leaves<typeof messages>;

export function ts(key: ShopMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
