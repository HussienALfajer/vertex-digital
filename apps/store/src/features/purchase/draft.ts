/*
 * The buy box's fields while a signed-out visitor signs in (S09 rule BB3): kept in this tab's
 * session storage, never in the URL, and restored when the sign-in returns to the same pack.
 * Storage can be unavailable: the fields are then typed again.
 */

const KEY = 'vd:buy-draft';

export interface BuyDraft {
  gameSlug: string;
  packId: string;
  quantity: number;
  fields: Record<string, string>;
}

export function saveDraft(draft: BuyDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Unavailable storage: the customer types the fields again.
  }
}

/** The draft for this game and pack, or null. */
export function readDraft(gameSlug: string, packId: string): BuyDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<BuyDraft> | null;
    if (value?.gameSlug !== gameSlug || value.packId !== packId) return null;
    const fields: Record<string, string> = {};
    for (const [key, field] of Object.entries(value.fields ?? {}))
      if (typeof field === 'string') fields[key] = field;
    const quantity = Number.isSafeInteger(value.quantity) ? (value.quantity as number) : 1;
    return { gameSlug, packId, quantity, fields };
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
