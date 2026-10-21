import messages from './messages.ar.json';

/*
 * Quick buy's own Arabic catalog (S22: the home row and its sheet, the gap, the deposit strip,
 * search commands, the quick-buy switch), apart from `messages/ar.json`, which every page ships in
 * its first load: only the parts that load with `next/dynamic` or on their own pages import it, so
 * the home, game and cart budgets hold (`e2e/store.spec.ts`). Same rules as `t()`.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type QuickBuyMessageKey = Leaves<typeof messages>;

export function tq(key: QuickBuyMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
