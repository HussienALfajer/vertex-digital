import type { FieldMap } from '@vertex-digital/contracts';

/*
 * The field map as the forms edit it (rule RT3): one row per supplier field, each mapped to an
 * input field key of the product's game, or not yet.
 */

export interface FieldMapEntry {
  /** The supplier's field name. */
  field: string;
  /** The game's input field key; empty while unmapped. */
  key: string;
  /** A field the supplier publishes as required: its row cannot be removed or renamed. */
  required: boolean;
}

/** The required fields first, in their order, then the other fields `map` already holds. */
export function fieldMapEntries(
  required: readonly string[],
  map: Readonly<Record<string, string>> = {},
): FieldMapEntry[] {
  const known = new Set(required);
  return [
    ...required.map((field) => ({ field, key: map[field] ?? '', required: true })),
    ...Object.entries(map)
      .filter(([field]) => !known.has(field))
      .map(([field, key]) => ({ field, key, required: false })),
  ];
}

/**
 * S18: the proposed map of an offer's fields onto a game's (as rule SC8's link proposes it): the
 * same key, case and underscores aside (`playerId` and `player_id`); else one supplier field onto
 * a game of one field. A field without a match stays unmapped for the admin.
 */
export function proposedFieldMap(
  required: readonly string[],
  gameKeys: readonly string[],
): Record<string, string> {
  const plain = (key: string) => key.replaceAll('_', '').toLowerCase();
  return Object.fromEntries(
    required.flatMap((field) => {
      const same = gameKeys.find((key) => plain(key) === plain(field));
      if (same) return [[field, same]];
      return required.length === 1 && gameKeys.length === 1 ? [[field, gameKeys[0] as string]] : [];
    }),
  );
}

/** The map the API takes: the rows with a field name and a key, the field name trimmed. */
export function toFieldMap(entries: readonly FieldMapEntry[]): FieldMap {
  const map: FieldMap = {};
  for (const entry of entries) {
    const field = entry.field.trim();
    if (field && entry.key) map[field] = entry.key;
  }
  return map;
}

/** The supplier fields the offers publish as required, each once, in the order first seen. */
export function requiredFieldsOf(offers: readonly { requiredFields: string[] | null }[]): string[] {
  return [...new Set(offers.flatMap((offer) => offer.requiredFields ?? []))];
}

/** `ROUTE_FIELDS_UNMAPPED` names the supplier fields left unmapped (`details.fields`). */
export function unmappedOf(error: unknown): string[] {
  const details = (error as { details?: { fields?: unknown } } | null)?.details;
  return Array.isArray(details?.fields) ? (details.fields as string[]) : [];
}
