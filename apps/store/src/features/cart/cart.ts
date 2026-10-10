import { CART_LINES_MAX, cartLineKey } from '@vertex-digital/contracts';
import { CART_KEY, clearStoredCart, notifyCart } from './cart-keys';

/*
 * The cart (S10 rules CT1–CT3): one per browser, in `localStorage` (`vd-cart`, versioned), filled
 * signed out too and cleared at sign-out so player IDs do not stay on a shared device. Every read
 * and write is wrapped: without storage (private mode) the cart is off and the buy box works as in
 * S09. The server decides everything again at checkout; the cart only remembers what was chosen.
 */

const VERSION = 1;

export type CartPlayerCheck = {
  result: 'valid' | 'invalid' | 'unavailable' | 'not_supported';
  playerName: string | null;
};

/** What the cart page shows of a line without reading the catalog again. */
export interface CartLineDisplay {
  gameNameAr: string;
  productNameAr: string;
  cover: { url: string; width: number; height: number } | null;
  fields: { key: string; labelAr: string; value: string }[];
}

export interface CartLine {
  /** A local id, for editing and removing one line. */
  id: string;
  productId: string;
  gameSlug: string;
  quantity: number;
  /** The product's `max_quantity` when added: the stepper's limit (CT2). */
  maxQuantity: number;
  fields: Record<string, string>;
  /** The unit price when added; the cart page moves it to today's price (CT4). */
  expectedUnitPriceUsdUnits: number;
  confirmPlayer: boolean;
  /** The player check the customer saw (PV7), or null when none ran. */
  playerCheck: CartPlayerCheck | null;
  savePlayer?: { label: string };
  gift?: { senderName?: string; message?: string };
  display: CartLineDisplay;
}

export type NewCartLine = Omit<CartLine, 'id'>;

export type AddResult = { status: 'added'; lines: CartLine[] } | { status: 'full' | 'off' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> | null => {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    result[key] = item;
  }
  return result;
};

const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** One stored line, or null when it was changed by hand or comes from another version. */
function parseLine(value: unknown): CartLine | null {
  if (!isRecord(value)) return null;
  const fields = stringRecord(value.fields);
  const display = value.display;
  if (
    typeof value.id !== 'string' ||
    typeof value.productId !== 'string' ||
    typeof value.gameSlug !== 'string' ||
    !positiveInt(value.quantity) ||
    !positiveInt(value.maxQuantity) ||
    !positiveInt(value.expectedUnitPriceUsdUnits) ||
    typeof value.confirmPlayer !== 'boolean' ||
    !fields ||
    !isRecord(display) ||
    typeof display.gameNameAr !== 'string' ||
    typeof display.productNameAr !== 'string' ||
    !Array.isArray(display.fields)
  )
    return null;
  return value as unknown as CartLine;
}

/** The cart's lines; null when this browser has no storage (the cart is off). */
export function readCart(): CartLine[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CART_KEY);
  } catch {
    return null;
  }
  if (raw === null) return [];
  try {
    const stored = JSON.parse(raw) as unknown;
    if (!isRecord(stored) || stored.v !== VERSION || !Array.isArray(stored.lines)) return [];
    return stored.lines.flatMap((line) => parseLine(line) ?? []).slice(0, CART_LINES_MAX);
  } catch {
    return [];
  }
}

function writeCart(lines: CartLine[]): boolean {
  try {
    if (lines.length === 0) localStorage.removeItem(CART_KEY);
    else localStorage.setItem(CART_KEY, JSON.stringify({ v: VERSION, lines }));
  } catch {
    return false;
  }
  notifyCart();
  return true;
}

/** Rule CT3: a count above `max_quantity` becomes several lines (25 at most 10 → 10, 10, 5). */
export function splitCount(count: number, max: number): number[] {
  const parts: number[] = [];
  for (let left = count; left > 0; left -= max) parts.push(Math.min(left, max));
  return parts;
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

/**
 * Rule CT2: adds lines, all or none. A line with the same `cartLineKey` (product, canonical
 * fields, no gift) adds its quantity to an existing line up to `max_quantity`, the rest starting a
 * new line; a gift line is always its own. More than 10 lines in all: `full`, nothing added.
 */
export function addToCart(added: readonly NewCartLine[]): AddResult {
  const current = readCart();
  if (current === null) return { status: 'off' };
  const lines = current.map((line) => ({ ...line }));
  for (const line of added) {
    const key = cartLineKey(line);
    let left = line.quantity;
    if (key !== null) {
      for (const existing of lines) {
        if (left === 0) break;
        if (cartLineKey(existing) !== key) continue;
        const room = Math.max(0, line.maxQuantity - existing.quantity);
        const moved = Math.min(room, left);
        // The newest choice wins: today's price, the check shown, the confirmation and saving.
        Object.assign(existing, {
          quantity: existing.quantity + moved,
          maxQuantity: line.maxQuantity,
          expectedUnitPriceUsdUnits: line.expectedUnitPriceUsdUnits,
          confirmPlayer: existing.confirmPlayer || line.confirmPlayer,
          playerCheck: line.playerCheck ?? existing.playerCheck,
          ...(line.savePlayer && { savePlayer: line.savePlayer }),
        });
        left -= moved;
      }
    }
    for (const quantity of splitCount(left, line.maxQuantity))
      lines.push({ ...line, id: newId(), quantity });
  }
  if (lines.length > CART_LINES_MAX) return { status: 'full' };
  return writeCart(lines) ? { status: 'added', lines } : { status: 'off' };
}

/** Changes one line (its quantity, its price after a check, its confirmation). */
export function updateLine(id: string, changes: Partial<Omit<CartLine, 'id'>>): void {
  const lines = readCart();
  if (!lines) return;
  writeCart(lines.map((line) => (line.id === id ? { ...line, ...changes } : line)));
}

/** Puts an edited line in the place of the old one ("عدّل البيانات", CT6). */
export function replaceLine(id: string, line: NewCartLine): void {
  const lines = readCart();
  if (!lines) return;
  writeCart(lines.map((existing) => (existing.id === id ? { ...line, id } : existing)));
}

export function removeLine(id: string): void {
  const lines = readCart();
  if (!lines) return;
  writeCart(lines.filter((line) => line.id !== id));
}

/** After a paid checkout (CT6) and at sign-out (CT1). */
export const clearCart = clearStoredCart;
