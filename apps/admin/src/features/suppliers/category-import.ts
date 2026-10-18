import {
  type ImportCategory,
  type ImportDraft,
  type ImportDraftPack,
  type LinkCategory,
  MAX_IMPORT_ROWS,
  type OptionMap,
  unmappedOptions,
} from '@vertex-digital/contracts';

/*
 * The import and link dialogs' form state (S16 SC7, SC8, SC12, SC13) and the bodies they send.
 * Rows are kept in the draft's order; the API numbers refused rows in the order sent, so the
 * dialogs map them back through `sentOffers`.
 */

/** A pack of the draft as the dialogs edit it. */
export interface PackRow {
  offerId: string;
  selected: boolean;
  nameAr: string;
  /** As typed; empty for none. */
  gameAmount: string;
  /** Link only: an existing product to route, or null for a new pack. */
  productId: string | null;
  /** Link only (S17 WR7): the admin's choice, or null for the pre-set of `rowPriceBasis`. */
  priceBasis: boolean | null;
}

/**
 * S17 WR7: whether an existing product's new route counts for its price: the admin's choice, else
 * on only when the product has no unarchived route yet.
 */
export const rowPriceBasis = (row: PackRow, routedProducts: ReadonlySet<string>): boolean =>
  row.priceBasis ?? !(row.productId !== null && routedProducts.has(row.productId));

/** An option of a select field, with the supplier's value it is sent as (S16 MF2). */
export interface OptionRow {
  value: string;
  labelAr: string;
  supplierValue: string | null;
}

/** An input field of the new game, beside the supplier field it maps (null: the admin's own). */
export interface FieldRow {
  supplierKey: string | null;
  key: string;
  labelAr: string;
  /** `select` only for a supplier select (S16 MF3): its options come from the supplier. */
  type: 'digits' | 'text' | 'select';
  minLength: string;
  maxLength: string;
  required: boolean;
  /** A select's options; empty otherwise. */
  options: OptionRow[];
}

/** The packs grouped by their leaf category, in the draft's order (the import dialog's groups). */
export function packGroups(
  packs: readonly ImportDraftPack[],
): { leafCategoryId: string; leafName: string; packs: ImportDraftPack[] }[] {
  const groups = new Map<
    string,
    { leafCategoryId: string; leafName: string; packs: ImportDraftPack[] }
  >();
  for (const pack of packs) {
    const group = groups.get(pack.leafCategoryId) ?? {
      leafCategoryId: pack.leafCategoryId,
      leafName: pack.leafName,
      packs: [],
    };
    group.packs.push(pack);
    groups.set(pack.leafCategoryId, group);
  }
  return [...groups.values()];
}

/**
 * Every pack with its suggested name and amount (SC13); the packs that can be chosen are
 * selected, up to the 100 an import takes. In a link draft the proposed product is preset (SC8).
 * A pack refused only for its options (MF3) is selected too: `alignedRows` keeps it out until
 * the option map can send it.
 */
export function initialPackRows(draft: Pick<ImportDraft, 'packs'>): PackRow[] {
  let selected = 0;
  return draft.packs.map((pack) => {
    const choosable = pack.refusal === null || pack.refusal === 'FIELD_OPTIONS_DIFFER';
    const choose = choosable && selected < MAX_IMPORT_ROWS;
    if (choose) selected += 1;
    return {
      offerId: pack.offerId,
      selected: choose,
      nameAr: pack.suggestedNameAr,
      gameAmount: pack.suggestedGameAmount === null ? '' : String(pack.suggestedGameAmount),
      productId: pack.match?.productId ?? null,
      priceBasis: null,
    };
  });
}

/**
 * The rows aligned with the draft as read now: a pack refused since (ignored, mapped, missing)
 * is no longer selected, and a pack the draft gained comes unselected with its suggestions.
 */
export function alignedRows(
  draft: Pick<ImportDraft, 'packs'>,
  rows: readonly PackRow[],
): PackRow[] {
  const byOffer = new Map(rows.map((row) => [row.offerId, row]));
  return draft.packs.map((pack) => {
    const row = byOffer.get(pack.offerId) ?? {
      offerId: pack.offerId,
      selected: false,
      nameAr: pack.suggestedNameAr,
      gameAmount: pack.suggestedGameAmount === null ? '' : String(pack.suggestedGameAmount),
      productId: pack.match?.productId ?? null,
      priceBasis: null,
    };
    return pack.refusal === null ? row : { ...row, selected: false };
  });
}

/** The suggested fields (SC12, MF3) as editable rows, a select's options with their values. */
export function initialFieldRows(draft: Pick<ImportDraft, 'fields' | 'optionMap'>): FieldRow[] {
  return draft.fields.map((field) => {
    const sent = draft.optionMap[field.supplierKey] ?? {};
    return {
      supplierKey: field.supplierKey,
      key: field.key,
      labelAr: field.labelAr,
      type: field.type,
      minLength: field.minLength === null ? '' : String(field.minLength),
      maxLength: field.maxLength === null ? '' : String(field.maxLength),
      required: field.required,
      options: (field.options ?? []).map((option) => ({
        value: option.value,
        labelAr: option.labelAr,
        supplierValue: sent[option.value] ?? null,
      })),
    };
  });
}

/** What the import's field rows send: the field map, the option map, and our selects' values. */
export function importMaps(fields: readonly FieldRow[]): {
  fieldMap: Record<string, string>;
  optionMap: OptionMap;
  selects: Record<string, string[]>;
} {
  const fieldMap: Record<string, string> = {};
  const optionMap: OptionMap = {};
  const selects: Record<string, string[]> = {};
  for (const field of fields) {
    if (field.type === 'select') selects[field.key] = field.options.map((option) => option.value);
    if (!field.supplierKey || !field.key) continue;
    fieldMap[field.supplierKey] = field.key;
    if (field.type !== 'select') continue;
    optionMap[field.supplierKey] = Object.fromEntries(
      field.options.flatMap((option) =>
        option.supplierValue === null ? [] : [[option.value, option.supplierValue]],
      ),
    );
  }
  return { fieldMap, optionMap, selects };
}

/**
 * S16 MF3: the draft with its `FIELD_OPTIONS_DIFFER` refusals read again for the maps as edited
 * (an option removed or mapped makes a pack choosable); other refusals stay the server's.
 */
export function withOptionRefusals<Draft extends Pick<ImportDraft, 'packs'>>(
  draft: Draft,
  maps: {
    fieldMap: Readonly<Record<string, string>>;
    optionMap: OptionMap;
    selects: Readonly<Record<string, readonly string[]>>;
  },
): Draft {
  return {
    ...draft,
    packs: draft.packs.map((pack) => {
      if (pack.refusal !== null && pack.refusal !== 'FIELD_OPTIONS_DIFFER') return pack;
      const gaps = unmappedOptions(pack.fieldSpecs, maps.fieldMap, maps.optionMap, maps.selects);
      return { ...pack, refusal: gaps.length > 0 ? 'FIELD_OPTIONS_DIFFER' : null };
    }),
  };
}

/** A whole number typed in a field, or null for an empty one; NaN when it is not one. */
export function wholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

const newPack = (row: PackRow) => {
  const amount = wholeNumber(row.gameAmount);
  return {
    offerId: row.offerId,
    nameAr: row.nameAr,
    ...(amount === null ? {} : { gameAmount: amount }),
  };
};

/** The selected rows, in order: what a body sends and what `details.rows` indexes. */
export const sentOffers = (rows: readonly PackRow[]): string[] =>
  rows.filter((row) => row.selected).map((row) => row.offerId);

/**
 * `POST …/import` (SC7): the field map follows the field rows that came from the supplier, the
 * option map their select options (MF3).
 */
export function importBody(input: {
  game: ImportCategory['game'];
  cover: ImportCategory['cover'];
  fields: readonly FieldRow[];
  rows: readonly PackRow[];
}): ImportCategory {
  const { fieldMap, optionMap } = importMaps(input.fields);
  return {
    game: input.game,
    cover: input.cover,
    fields: input.fields.map((field) =>
      field.type === 'select'
        ? {
            key: field.key,
            labelAr: field.labelAr,
            type: 'select' as const,
            required: field.required,
            options: field.options.map((option) => ({
              value: option.value,
              labelAr: option.labelAr,
            })),
          }
        : {
            key: field.key,
            labelAr: field.labelAr,
            type: field.type,
            required: field.required,
            minLength: wholeNumber(field.minLength),
            maxLength: wholeNumber(field.maxLength),
          },
    ),
    fieldMap,
    optionMap,
    rows: input.rows.filter((row) => row.selected).map(newPack),
  };
}

/**
 * `POST …/link` (SC8): a row with a product routes it, counting for its price or not (S17 WR7);
 * the others create new packs.
 */
export function linkBody(input: {
  gameId: string;
  fieldMap: Record<string, string>;
  optionMap: OptionMap;
  rows: readonly PackRow[];
  routedProducts: ReadonlySet<string>;
}): LinkCategory {
  return {
    gameId: input.gameId,
    fieldMap: input.fieldMap,
    optionMap: input.optionMap,
    rows: input.rows
      .filter((row) => row.selected)
      .map((row) =>
        row.productId
          ? {
              offerId: row.offerId,
              productId: row.productId,
              priceBasis: rowPriceBasis(row, input.routedProducts),
            }
          : newPack(row),
      ),
  };
}

/** A refused row as the API names it (`details.rows`, S07 rule RT8's shape). */
export interface RowRefusal {
  index: number;
  code: string;
  fields?: string[];
}

/** The refusals keyed by offer id, from the indexes of the rows that were sent. */
export function refusalsByOffer(
  refusals: readonly RowRefusal[],
  sent: readonly string[],
): Map<string, RowRefusal> {
  const byOffer = new Map<string, RowRefusal>();
  for (const refusal of refusals) {
    const offerId = sent[refusal.index];
    if (offerId) byOffer.set(offerId, refusal);
  }
  return byOffer;
}
