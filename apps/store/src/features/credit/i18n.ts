import messages from './messages.ar.json';

/*
 * The credit section's own Arabic catalog (S25: SYP-first prices, the free amount, the recipient
 * typed twice, the section's limits and the cash hold), apart from `messages/ar.json`, which every
 * page ships in its first load. Same rules as `t()`.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type CreditMessageKey = Leaves<typeof messages>;

export function tcr(key: CreditMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
