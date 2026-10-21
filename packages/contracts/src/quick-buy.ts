import { z } from 'zod';
import {
  catalogImageSchema,
  normalizeSearchText,
  type ProductKind,
  productKindSchema,
  quickCodeSchema,
  type SearchIndex,
  searchCatalog,
} from './catalog.js';
import {
  amountUnitsSchema,
  ceilToStep,
  floorToWholeCents,
  USD_CENT,
  usdToSyp,
  walletSypValue,
} from './money.js';
import { savedPlayerSchema } from './orders.js';
import { priceKindSchema } from './price-kinds.js';

/*
 * Quick buy (S22 F40, ADR 0037): the home page's "top up again" row, direct buy links and their
 * counts, "top up the gap", the best-value badge and search commands. Owned by the api `orders`
 * module (the row, the gap) and `catalog` (links, best value). No new money flow: every purchase
 * is S08 M1, every gap an S09 reservation and an S03 or S04 deposit.
 */

/** QB2: at most 6 cards on the home page. */
export const QUICK_BUY_CARDS = 6;

/** DL2, DL4: what a link event counts. */
export const QUICK_LINK_EVENT_KINDS = ['open', 'order'] as const;

/** DL4: an order's attribution is kept 24 hours after the link's open. */
export const QUICK_LINK_ATTRIBUTION_HOURS = 24;

/** Link events are deleted after 90 days (the sweep); the panel reads at most that far back. */
export const QUICK_LINK_RETENTION_DAYS = 90;

/** DL5: the panel's default range. */
export const QUICK_LINK_STATS_DAYS = 30;

/** BV1: best value needs at least 3 considered packs. */
export const BEST_VALUE_MIN_PACKS = 3;

/** BV2: the best pack leads the next by at least 2% per unit. */
export const BEST_VALUE_MIN_LEAD_BPS = 200;

const BASIS_POINTS = 10_000;

/* Top up the gap (BG1–BG5) ------------------------------------------------------------------- */

/**
 * BG1: what the customer lacks to pay `total` after the open reservations, which A02 pays first:
 * `max(0, total + reserved − balance)`, rounded up to whole cents.
 */
export function depositGap(input: {
  totalUsdUnits: number;
  balanceUsdUnits: number;
  reservedUsdUnits: number;
}): number {
  const gap = input.totalUsdUnits + input.reservedUsdUnits - input.balanceUsdUnits;
  return gap <= 0 ? 0 : ceilToStep(gap, USD_CENT);
}

export interface GapDepositLimits {
  /** The method's minimum, in USD units. */
  minUnits: number;
  perDepositMaxUnits: number;
  /** What the 24-hour window still allows. */
  remainingUnits: number;
  /** For SYP: the rate and the display step the pounds round up to. */
  rate: string | null;
  stepSypUnits: number;
}

export interface GapDepositAmount {
  /** The USD the deposit should credit, whole cents. */
  usdUnits: number;
  /** For SYP: the pounds to send, whole pounds on the step; null for USD or without a rate. */
  sypUnits: number | null;
  /** The gap was below the method's minimum. */
  raisedToMinimum: boolean;
  /** A cap (per deposit or what remains today) is below the gap: the rest needs another deposit. */
  short: boolean;
}

/**
 * BG3: the amount the deposit form holds for a gap: `max(gap, minimum)`, capped by the per-deposit
 * maximum and what remains today. For SYP, the pounds `usd × rate` rounded up to the display step:
 * as the step is whole pounds and the pounds are never below `usd × rate`, the credit
 * (`sypDepositUsd`, rounded down to whole cents) is never below `usd`. A capped SYP amount rounds
 * down to the step instead, so it stays within the cap.
 */
export function gapDepositAmount(
  gapUsdUnits: number,
  currency: 'USD' | 'SYP',
  limits: GapDepositLimits,
): GapDepositAmount {
  const raisedToMinimum = gapUsdUnits < limits.minUnits;
  const wanted = Math.max(gapUsdUnits, limits.minUnits);
  const cap = floorToWholeCents(Math.min(limits.perDepositMaxUnits, limits.remainingUnits));
  const short = wanted > cap;
  const usdUnits = short ? cap : wanted;
  if (currency === 'USD' || limits.rate === null) {
    return { usdUnits, sypUnits: null, raisedToMinimum, short };
  }
  const step = limits.stepSypUnits;
  const sypUnits = short
    ? walletSypValue(usdUnits, limits.rate, step)
    : ceilToStep(usdToSyp(usdUnits, limits.rate, 'up'), step);
  return { usdUnits, sypUnits, raisedToMinimum, short };
}

/* Best value (BV1–BV3) ----------------------------------------------------------------------- */

export interface BestValuePack {
  id: string;
  kind: ProductKind;
  gameAmount: number | null;
  available: boolean;
  priceUsdUnits: number | null;
}

export interface BestValue {
  /** BV2: the price per 100 units of each considered pack, whole cents rounded up (display). */
  perHundredUsdUnits: Record<string, number>;
  /** BV2: the pack with the badge, or null. */
  bestProductId: string | null;
}

type ConsideredPack = { id: string; amount: bigint; price: bigint };

/** `a` costs less per unit than `b`, compared by cross-multiplying (never the rounded figures). */
const cheaperPerUnit = (a: ConsideredPack, b: ConsideredPack) =>
  a.price * b.amount < b.price * a.amount;

/**
 * BV1–BV2 over the prices the viewer sees: the considered packs are available, `direct`, with an
 * in-game amount above 1 and a price. With fewer than 3 nothing is shown. The badge goes to the
 * cheapest per unit when it is at least 2% below the next (`best × 10000 ≤ next × 9800`).
 */
export function bestValue(packs: readonly BestValuePack[], enabled: boolean): BestValue {
  const considered: ConsideredPack[] = enabled
    ? packs.flatMap((pack) =>
        pack.available &&
        pack.kind === 'direct' &&
        pack.gameAmount !== null &&
        pack.gameAmount > 1 &&
        pack.priceUsdUnits !== null
          ? [{ id: pack.id, amount: BigInt(pack.gameAmount), price: BigInt(pack.priceUsdUnits) }]
          : [],
      )
    : [];
  if (considered.length < BEST_VALUE_MIN_PACKS)
    return { perHundredUsdUnits: {}, bestProductId: null };
  const perHundredUsdUnits: Record<string, number> = {};
  for (const pack of considered) {
    const raw = (pack.price * 100n + pack.amount - 1n) / pack.amount;
    perHundredUsdUnits[pack.id] = ceilToStep(Number(raw), USD_CENT);
  }
  const sorted = [...considered].sort((a, b) =>
    cheaperPerUnit(a, b) ? -1 : cheaperPerUnit(b, a) ? 1 : 0,
  );
  const [best, next] = sorted as [ConsideredPack, ConsideredPack];
  const lead =
    best.price * next.amount * BigInt(BASIS_POINTS) <=
    next.price * best.amount * BigInt(BASIS_POINTS - BEST_VALUE_MIN_LEAD_BPS);
  return { perHundredUsdUnits, bestProductId: lead ? best.id : null };
}

/* Search commands (SC1–SC5) ------------------------------------------------------------------ */

/** SC1: the amount's bounds. */
export const SEARCH_COMMAND_MAX_AMOUNT = 1_000_000;

/** SC3: at most 5 command results. */
export const SEARCH_COMMANDS_MAX = 5;

/** SC1: the words that may lead a label ("لـ" is "ل" once normalized). */
const LABEL_PREFIXES = ['ل', 'الي'];

export interface SearchCommandPlayer {
  id: string;
  label: string;
  gameSlug: string;
}

export interface SearchCommand {
  game: SearchIndex['games'][number];
  /** Null for a label alone (SC5). */
  product: SearchIndex['products'][number] | null;
  savedPlayer: { id: string; label: string } | null;
}

/** Arabic-Indic and Persian digits to Latin, then thousands separators between digits dropped. */
function withLatinAmount(query: string): string {
  return query
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/(\d)[,،٬'](?=\d{3}(?!\d))/g, '$1');
}

/** The tokens of a label found in `tokens` at `start`, with a leading "ل" or a prefix word. */
function labelSpan(tokens: readonly string[], start: number, label: readonly string[]) {
  const first = label[0] as string;
  let at = start;
  if (LABEL_PREFIXES.includes(tokens[at] as string) && tokens[at + 1] === first) at += 1;
  else if (tokens[at] !== first && tokens[at] !== `ل${first}`) return null;
  for (let offset = 1; offset < label.length; offset += 1) {
    if (tokens[at + offset] !== label[offset]) return null;
  }
  return { start, end: at + label.length };
}

/**
 * SC1–SC5: the purchase commands a search query names. One number (1–1,000,000) is the amount; a
 * saved ID's label (signed in: `savedPlayers` not null) is matched with or without a leading "لـ",
 * the longest label winning; the other words go to the game search. Candidates are the available
 * packs with that in-game amount, else whose name holds the number, of the matching games (the
 * label's games when a label was typed). A label alone opens its game with the ID chosen (SC5).
 * Nothing is bought here: a command only opens the game page on the slide step (SC3).
 */
export function parseSearchCommand(
  query: string,
  index: SearchIndex,
  savedPlayers: readonly SearchCommandPlayer[] | null,
): SearchCommand[] {
  const tokens = normalizeSearchText(withLatinAmount(query))
    .split(' ')
    .filter((token) => token !== '');
  const numbers = tokens.filter((token) => /^\d+$/.test(token));
  const amount = numbers.length === 1 ? Number(numbers[0]) : null;
  const validAmount = amount !== null && amount >= 1 && amount <= SEARCH_COMMAND_MAX_AMOUNT;

  let players: SearchCommandPlayer[] = [];
  let used = new Set<number>();
  const labels = new Map<string, SearchCommandPlayer[]>();
  for (const player of savedPlayers ?? []) {
    const key = normalizeSearchText(player.label);
    if (key !== '') labels.set(key, [...(labels.get(key) ?? []), player]);
  }
  let longest = -1;
  for (const [key, owners] of labels) {
    if (key.length <= longest) continue;
    const label = key.split(' ');
    for (let start = 0; start < tokens.length; start += 1) {
      const span = labelSpan(tokens, start, label);
      if (span === null) continue;
      longest = key.length;
      players = owners;
      used = new Set(Array.from({ length: span.end - span.start }, (_, i) => span.start + i));
      break;
    }
  }
  if (!validAmount && players.length === 0) return [];

  const words = tokens.filter((token, at) => !used.has(at) && !/^\d+$/.test(token)).join(' ');
  const matchedGames = words === '' ? index.games : searchCatalog(index, words).games;
  const games = new Map(
    matchedGames
      .filter((game) => players.length === 0 || players.some((p) => p.gameSlug === game.slug))
      .map((game) => [game.slug, game]),
  );
  const playersOf = (slug: string) =>
    players.length === 0
      ? [null]
      : players.filter((p) => p.gameSlug === slug).map((p) => ({ id: p.id, label: p.label }));

  if (!validAmount) {
    return [...games.values()]
      .flatMap((game) =>
        playersOf(game.slug).map((savedPlayer) => ({ game, product: null, savedPlayer })),
      )
      .slice(0, SEARCH_COMMANDS_MAX);
  }
  const packs = index.products.filter((pack) => pack.available && games.has(pack.gameSlug));
  const exact = packs.filter((pack) => pack.gameAmount === amount);
  const candidates =
    exact.length > 0
      ? exact
      : packs.filter((pack) =>
          normalizeSearchText(pack.nameAr).split(' ').includes(String(amount)),
        );
  return candidates
    .flatMap((product) => {
      const game = games.get(product.gameSlug) as SearchCommand['game'];
      return playersOf(game.slug).map((savedPlayer) => ({ game, product, savedPlayer }));
    })
    .slice(0, SEARCH_COMMANDS_MAX);
}

/* Schemas ------------------------------------------------------------------------------------ */

/** QB3: what a card opens: the home sheet when `ready`, else the game page. */
export const QUICK_BUY_STATES = ['ready', 'unavailable', 'rejected', 'incomplete'] as const;

export const quickBuyStateSchema = z.enum(QUICK_BUY_STATES).meta({ id: 'QuickBuyState' });

export type QuickBuyState = z.infer<typeof quickBuyStateSchema>;

/** `GET /api/quick-buy` (QB1–QB3): newest-used saved IDs first, at most 6. */
export const quickBuySchema = z
  .object({
    items: z.array(
      z.object({
        savedPlayer: savedPlayerSchema,
        game: z.object({
          slug: z.string(),
          nameAr: z.string(),
          cover: catalogImageSchema.nullable(),
        }),
        product: z.object({
          id: z.uuid(),
          nameAr: z.string(),
          kind: productKindSchema,
          gameAmount: z.int().nullable(),
        }),
        quantity: z.int().positive(),
        /** Today's unit price on the customer's effective list; null while unavailable. */
        unitPriceUsdUnits: z.int().positive().nullable(),
        /** The unit price's SYP display price; null without a rate or a price. */
        unitPriceSypUnits: z.int().nullable(),
        priceKind: priceKindSchema,
        state: quickBuyStateSchema,
      }),
    ),
  })
  .meta({ id: 'QuickBuy' });

export type QuickBuy = z.infer<typeof quickBuySchema>;

export type QuickBuyItem = QuickBuy['items'][number];

/** `GET /api/q/:code` query (DL1). */
export const quickLinkQuerySchema = z
  .object({ c: z.string().max(200).optional() })
  .meta({ id: 'QuickLinkQuery' });

export type QuickLinkQuery = z.infer<typeof quickLinkQuerySchema>;

/** `GET /api/q/:code` (DL2): where the store redirects. */
export const quickLinkResolveSchema = z
  .discriminatedUnion('target', [
    z.object({ target: z.literal('pack'), gameSlug: z.string(), productId: z.uuid() }),
    z.object({ target: z.literal('game'), gameSlug: z.string() }),
    z.object({ target: z.literal('home') }),
  ])
  .meta({ id: 'QuickLinkResolve' });

export type QuickLinkResolve = z.infer<typeof quickLinkResolveSchema>;

/** `GET /api/admin/quick-links` query (DL5): a range within the last 90 days. */
export const quickLinkStatsQuerySchema = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime(), productId: z.uuid().optional() })
  .refine((query) => Date.parse(query.from) < Date.parse(query.to), {
    path: ['to'],
    message: 'Expected to after from',
  })
  .refine(
    (query) =>
      Date.parse(query.to) - Date.parse(query.from) <= QUICK_LINK_RETENTION_DAYS * 86_400_000,
    { path: ['from'], message: `Expected at most ${QUICK_LINK_RETENTION_DAYS} days` },
  )
  .meta({ id: 'QuickLinkStatsQuery' });

export type QuickLinkStatsQuery = z.infer<typeof quickLinkStatsQuerySchema>;

/** `GET /api/admin/quick-links` (DL5): one row per product and campaign (null: untagged). */
export const quickLinkStatsSchema = z
  .object({
    items: z.array(
      z.object({
        productId: z.uuid(),
        productNameAr: z.string(),
        gameNameAr: z.string(),
        quickCode: quickCodeSchema,
        campaign: z.string().nullable(),
        opens: z.int().nonnegative(),
        /** Paid orders (reservations once A02 paid them), test customers excluded. */
        orders: z.int().nonnegative(),
        /** Their totals net of refunds. */
        revenueUsdUnits: amountUnitsSchema,
      }),
    ),
  })
  .meta({ id: 'QuickLinkStats' });

export type QuickLinkStats = z.infer<typeof quickLinkStatsSchema>;
