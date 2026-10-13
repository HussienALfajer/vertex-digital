import {
  type ImportCategory,
  type ImportDraft,
  type ImportDraftPack,
  type LinkCategory,
  MAX_IMPORT_ROWS,
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
}

/** An input field of the new game, beside the supplier field it maps (null: the admin's own). */
export interface FieldRow {
  supplierKey: string | null;
  key: string;
  labelAr: string;
  type: 'digits' | 'text';
  minLength: string;
  maxLength: string;
  required: boolean;
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
 */
export function initialPackRows(draft: Pick<ImportDraft, 'packs'>): PackRow[] {
  let selected = 0;
  return draft.packs.map((pack) => {
    const choose = pack.refusal === null && selected < MAX_IMPORT_ROWS;
    if (choose) selected += 1;
    return {
      offerId: pack.offerId,
      selected: choose,
      nameAr: pack.suggestedNameAr,
      gameAmount: pack.suggestedGameAmount === null ? '' : String(pack.suggestedGameAmount),
      productId: pack.match?.productId ?? null,
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
    };
    return pack.refusal === null ? row : { ...row, selected: false };
  });
}

/** The suggested fields (SC12) as editable rows. */
export function initialFieldRows(draft: Pick<ImportDraft, 'fields'>): FieldRow[] {
  return draft.fields.map((field) => ({
    supplierKey: field.supplierKey,
    key: field.key,
    labelAr: field.labelAr,
    type: field.type,
    minLength: String(field.minLength),
    maxLength: String(field.maxLength),
    required: field.required,
  }));
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

/** `POST …/import` (SC7): the field map follows the field rows that came from the supplier. */
export function importBody(input: {
  game: ImportCategory['game'];
  cover: ImportCategory['cover'];
  fields: readonly FieldRow[];
  rows: readonly PackRow[];
}): ImportCategory {
  const fieldMap: Record<string, string> = {};
  for (const field of input.fields) {
    if (field.supplierKey && field.key) fieldMap[field.supplierKey] = field.key;
  }
  return {
    game: input.game,
    cover: input.cover,
    fields: input.fields.map((field) => ({
      key: field.key,
      labelAr: field.labelAr,
      type: field.type,
      required: field.required,
      minLength: wholeNumber(field.minLength),
      maxLength: wholeNumber(field.maxLength),
    })),
    fieldMap,
    rows: input.rows.filter((row) => row.selected).map(newPack),
  };
}

/** `POST …/link` (SC8): a row with a product routes it; the others create new packs. */
export function linkBody(input: {
  gameId: string;
  fieldMap: Record<string, string>;
  rows: readonly PackRow[];
}): LinkCategory {
  return {
    gameId: input.gameId,
    fieldMap: input.fieldMap,
    rows: input.rows
      .filter((row) => row.selected)
      .map((row) =>
        row.productId ? { offerId: row.offerId, productId: row.productId } : newPack(row),
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
