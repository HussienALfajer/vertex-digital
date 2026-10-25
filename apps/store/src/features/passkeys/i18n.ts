import messages from './messages.ar.json';

/*
 * The passkeys' own Arabic catalog (S22 PK2–PK4: the account card, its dialogs and the sign-in
 * button), apart from `messages/ar.json`, which every page ships in its first load: only the parts
 * loaded with `next/dynamic` import it. Same rules as `t()`.
 */

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type PasskeyMessageKey = Leaves<typeof messages>;

export function tp(key: PasskeyMessageKey, values?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)[part];
  const text = node as string;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
