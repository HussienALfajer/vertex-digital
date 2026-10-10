import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToCart,
  type CartLine,
  clearCart,
  type NewCartLine,
  readCart,
  removeLine,
  replaceLine,
  splitCount,
  updateLine,
} from './cart';
import { CART_EVENT, CART_KEY, storedLineCount, subscribeCart } from './cart-keys';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const PRODUCT = '0199e000-0000-7000-8000-0000000000a1';
const OTHER = '0199e000-0000-7000-8000-0000000000a2';

const line = (changes: Partial<NewCartLine> = {}): NewCartLine => ({
  productId: PRODUCT,
  gameSlug: 'pubg-mobile',
  quantity: 1,
  maxQuantity: 10,
  fields: { player_id: '51234567' },
  expectedUnitPriceUsdUnits: 990_000,
  confirmPlayer: false,
  playerCheck: null,
  display: { gameNameAr: 'ببجي', productNameAr: '60 UC', cover: null, fields: [] },
  ...changes,
});

let storage: Storage;
const events: string[] = [];

beforeEach(() => {
  storage = memoryStorage();
  events.length = 0;
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { dispatchEvent: (event: Event) => events.push(event.type) });
});

afterEach(() => vi.unstubAllGlobals());

const added = (result: ReturnType<typeof addToCart>): CartLine[] => {
  if (result.status !== 'added') throw new Error(result.status);
  return result.lines;
};

describe('the cart (rules CT1–CT3)', () => {
  it('starts empty, stores versioned lines and tells the tab', () => {
    expect(readCart()).toEqual([]);
    const lines = added(addToCart([line()]));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(storage.getItem(CART_KEY) ?? '')).toMatchObject({ v: 1 });
    expect(readCart()).toEqual(lines);
    expect(events).toEqual([CART_EVENT]);
  });

  it('merges a line with the same product and fields, up to the maximum, then a new line', () => {
    added(addToCart([line({ quantity: 4 })]));
    // The same values, spaced differently: the canonical fields are the same.
    const merged = added(
      addToCart([
        line({
          quantity: 3,
          fields: { player_id: ' 51234567 ' },
          expectedUnitPriceUsdUnits: 1_000_000,
          confirmPlayer: true,
          playerCheck: { result: 'valid', playerName: 'Lina' },
          savePlayer: { label: 'حسابي' },
        }),
      ]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      quantity: 7,
      expectedUnitPriceUsdUnits: 1_000_000,
      confirmPlayer: true,
      playerCheck: { result: 'valid', playerName: 'Lina' },
      savePlayer: { label: 'حسابي' },
    });
    const over = added(addToCart([line({ quantity: 6 })]));
    expect(over.map((item) => item.quantity)).toEqual([10, 3]);
    // A later merge keeps the confirmation and the check already there.
    const kept = added(addToCart([line({ quantity: 1 })]));
    expect(kept[0]).toMatchObject({ confirmPlayer: true, playerCheck: { result: 'valid' } });
    expect(kept.map((item) => item.quantity)).toEqual([10, 4]);
  });

  it('keeps gift lines and other products apart', () => {
    added(addToCart([line()]));
    const lines = added(
      addToCart([line({ gift: { message: 'كل عام وأنت بخير' } }), line({ gift: {} })]),
    );
    expect(lines).toHaveLength(3);
    expect(added(addToCart([line({ productId: OTHER })]))).toHaveLength(4);
  });

  it('refuses everything past 10 lines', () => {
    added(addToCart(Array.from({ length: 9 }, (_, index) => line({ fields: { id: `${index}` } }))));
    expect(addToCart([line({ fields: { id: 'a' } }), line({ fields: { id: 'b' } })])).toEqual({
      status: 'full',
    });
    expect(readCart()).toHaveLength(9);
    expect(addToCart([line({ quantity: 25, fields: { id: 'c' } })])).toEqual({ status: 'full' });
    expect(added(addToCart([line({ fields: { id: 'd' } })]))).toHaveLength(10);
  });

  it('changes, replaces and removes one line, and clears at sign-out', () => {
    const [first, second] = added(addToCart([line(), line({ productId: OTHER })]));
    if (!first || !second) throw new Error('two lines');
    updateLine(first.id, { quantity: 5, confirmPlayer: true });
    expect(readCart()?.[0]).toMatchObject({ quantity: 5, confirmPlayer: true });
    replaceLine(second.id, line({ productId: OTHER, fields: { player_id: '99999999' } }));
    expect(readCart()?.[1]).toMatchObject({ id: second.id, fields: { player_id: '99999999' } });
    removeLine(first.id);
    expect(readCart()?.map((item) => item.id)).toEqual([second.id]);
    clearCart();
    expect(storage.getItem(CART_KEY)).toBeNull();
    expect(readCart()).toEqual([]);
  });

  it('drops what it cannot read', () => {
    storage.setItem(CART_KEY, '{not json');
    expect(readCart()).toEqual([]);
    storage.setItem(CART_KEY, JSON.stringify({ v: 2, lines: [] }));
    expect(readCart()).toEqual([]);
    storage.setItem(CART_KEY, JSON.stringify([]));
    expect(readCart()).toEqual([]);
    const good = { ...line(), id: 'x' };
    storage.setItem(
      CART_KEY,
      JSON.stringify({
        v: 1,
        lines: [
          good,
          { ...good, quantity: 0 },
          { ...good, fields: { a: 1 } },
          { ...good, fields: [] },
          { ...good, display: null },
          'line',
        ],
      }),
    );
    expect(readCart()).toEqual([good]);
  });

  it('is off without storage, and writes nothing then', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(readCart()).toBeNull();
    expect(addToCart([line()])).toEqual({ status: 'off' });
    updateLine('x', { quantity: 2 });
    replaceLine('x', line());
    removeLine('x');
    expect(events).toEqual([]);
  });

  it('is off when storage refuses to save', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(addToCart([line()])).toEqual({ status: 'off' });
  });

  it('works without a window to tell', () => {
    vi.stubGlobal('window', undefined);
    expect(added(addToCart([line()]))).toHaveLength(1);
  });
});

describe('splitCount (rule CT3)', () => {
  it('splits a count by the maximum', () => {
    expect(splitCount(25, 10)).toEqual([10, 10, 5]);
    expect(splitCount(10, 10)).toEqual([10]);
    expect(splitCount(3, 10)).toEqual([3]);
    expect(splitCount(0, 10)).toEqual([]);
  });
});

describe('the header count and sign-out (rule CT1)', () => {
  it('counts the lines, and is null without storage', () => {
    expect(storedLineCount()).toBe(0);
    added(addToCart([line(), line({ productId: OTHER })]));
    expect(storedLineCount()).toBe(2);
    storage.setItem(CART_KEY, '{not json');
    expect(storedLineCount()).toBe(0);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(storedLineCount()).toBeNull();
    clearCart();
  });

  it('hears this tab and other tabs', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    const onChange = vi.fn();
    const stop = subscribeCart(onChange);
    listeners.get(CART_EVENT)?.({});
    listeners.get('storage')?.({ key: CART_KEY });
    listeners.get('storage')?.({ key: null });
    listeners.get('storage')?.({ key: 'vertex-theme' });
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
    expect(listeners.size).toBe(0);
  });
});
