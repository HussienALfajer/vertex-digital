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
