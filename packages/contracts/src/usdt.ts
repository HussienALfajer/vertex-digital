import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { z } from 'zod';
import { CURRENCY_SCALE, isWholeCents } from './money.js';

/*
 * USDT deposits (S04, F06; ADR 0006, 0018): the two networks, their official contracts, the exact
 * amount's tail, TXIDs and receiving addresses. Owned by the api `deposits` module; the worker's
 * chain readers use the same constants.
 */

/** The USDT payment methods, one per network (ADR 0006). */
export const USDT_METHODS = ['usdt_trc20', 'usdt_bep20'] as const;

export const usdtMethodSchema = z.enum(USDT_METHODS).meta({ id: 'UsdtMethod' });

export type UsdtMethod = z.infer<typeof usdtMethodSchema>;

export function isUsdtMethod(method: string): method is UsdtMethod {
  return (USDT_METHODS as readonly string[]).includes(method);
}

export interface UsdtNetwork {
  /** The official USDT contract: only transfers of this token count (rule U10, ADR 0018). */
  contract: string;
  /** The token's decimals on chain. */
  decimals: number;
  /** Confirmations shown as "required" to the customer; finality is checked as rule U6 says. */
  confirmations: number;
  /** The explorer's page for a transaction, from its normalized TXID. */
  explorerTxUrl: (txid: string) => string;
}

/**
 * The networks (ADR 0006). Contracts checked on 2026-10-08:
 * - TRON: Tronscan's contract page names `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` "Tether USD"
 *   (TetherToken, created April 2019); it passes its base58check (`usdt.test.ts`).
 * - BSC: `0x55d398326f99059fF775485246999027B3197955`, the USDT listed by BscScan and the
 *   BSC trackers; it passes its EIP-55 checksum (`usdt.test.ts`). Tether's own page could not be
 *   reached from the build environment: the owner's live check confirms it (spec Acceptance).
 */
export const USDT_NETWORKS = {
  usdt_trc20: {
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    confirmations: 19,
    explorerTxUrl: (txid) => `https://tronscan.org/#/transaction/${txid}`,
  },
  usdt_bep20: {
    contract: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    confirmations: 15,
    explorerTxUrl: (txid) => `https://bscscan.com/tx/0x${txid}`,
  },
} as const satisfies Record<UsdtMethod, UsdtNetwork>;

/** The tail added to a deposit's amount (rule U3): 0.0001–0.0099 USDT, in USD units. */
export const USDT_TAIL_MIN_UNITS = 100;
export const USDT_TAIL_MAX_UNITS = 9_900;
export const USDT_TAIL_STEP_UNITS = 100;

/** An expired or cancelled deposit's amount stays reserved this long (rule U4). */
export const USDT_RESERVATION_GRACE_DAYS = 7;
/** Transfers below $1 are not recorded (rule U14). */
export const USDT_DUST_THRESHOLD_UNITS = 1 * CURRENCY_SCALE.USD;
/** TXID submissions per deposit and per customer per hour (rule U8). */
export const MAX_TXID_SUBMISSIONS = 5;
export const TXID_SUBMISSIONS_PER_HOUR = 20;
/** A TXID not found is looked for this long before it bounces (rule U9). */
export const TXID_SEARCH_MINUTES = 30;
/** A scanner without a successful run for this long makes its network `delayed` (rule U12). */
export const USDT_SCANNER_STALE_MINUTES = 10;

/* TXIDs ---------------------------------------------------------------------------------- */

const BARE_TXID = /^(?:0x)?([0-9a-f]{64})$/i;
const EXPLORER_TXID =
  /^(?:https?:\/\/)?(?:www\.)?(?:tronscan\.(?:org|io)\/(?:#\/)?transaction\/|bscscan\.com\/tx\/)(?:0x)?([0-9a-f]{64})(?:[/?#].*)?$/i;

/** The 64 lower-case hex characters of a TXID, hash or explorer link, or null (rule U8). */
export function normalizeTxid(text: string): string | null {
  const value = text.trim();
  const hash = BARE_TXID.exec(value)?.[1] ?? EXPLORER_TXID.exec(value)?.[1];
  return hash === undefined ? null : hash.toLowerCase();
}

/**
 * A TXID as a customer or the admin pastes it: a bare 64-hex hash, `0x`-prefixed or not, or a
 * Tronscan or BscScan transaction link, any case. Normalizes to 64 lower-case hex characters.
 */
export const txidSchema = z
  .string()
  .max(300)
  .transform((value, context) => {
    const txid = normalizeTxid(value);
    if (txid === null) {
      context.addIssue({ code: 'custom', message: 'Expected a TXID or an explorer link' });
      return z.NEVER;
    }
    return txid;
  });

/* Receiving addresses (rule U1) ---------------------------------------------------------- */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The bytes of a base58 string already checked against the alphabet, with no leading `1`. */
function base58Decode(text: string): number[] {
  let value = 0n;
  for (const character of text) value = value * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  return bytes;
}

/** The base58check text of a TRON address's 21 bytes (prefix 0x41 and the 20-byte account). */
function base58CheckEncode(bytes: Uint8Array): string {
  const checksum = sha256(sha256(bytes)).subarray(0, 4);
  let value = 0n;
  for (const byte of [...bytes, ...checksum]) value = (value << 8n) | BigInt(byte);
  let text = '';
  while (value > 0n) {
    text = (BASE58_ALPHABET[Number(value % 58n)] as string) + text;
    value /= 58n;
  }
  return text;
}

/**
 * The `T…` address of a TRON account given in hex: 40 characters (as in event logs and topics,
 * left-padded topics trimmed to their last 40) or 42 with the `41` prefix (as in the node's
 * transaction fields). Null for anything else.
 */
export function tronAddressFromHex(hex: string): string | null {
  const account = /^(?:0x|41)?([0-9a-f]{40})$/i.exec(hex)?.[1];
  if (account === undefined) return null;
  const bytes = Uint8Array.from([
    0x41,
    ...(account.match(/../g) as string[]).map((pair) => Number.parseInt(pair, 16)),
  ]);
  return base58CheckEncode(bytes);
}

/** A TRON address: `T`, 34 base58 characters, prefix byte 0x41 and a valid base58check. */
export function isTronAddress(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  // 34 characters starting with `T` always decode to 25 bytes, 0x40 to 0x43 first.
  const bytes = base58Decode(address);
  if (bytes[0] !== 0x41) return false;
  const checksum = sha256(sha256(Uint8Array.from(bytes.slice(0, 21)))).subarray(0, 4);
  return checksum.every((byte, index) => byte === bytes[21 + index]);
}

/**
 * A BSC (EVM) address: `0x` and 40 hex characters. All lower or all upper case is accepted;
 * mixed case must be its EIP-55 checksum, so a mistyped character is caught.
 */
export function isEvmAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = keccak_256(new TextEncoder().encode(hex.toLowerCase()));
  return [...hex].every((character, index) => {
    const byte = hash[index >> 1] as number;
    const nibble = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    return /\d/.test(character) || nibble >= 8 === (character === character.toUpperCase());
  });
}

/** The receiving address of each network, checked when the api and worker boot (rule U1). */
export const usdtAddressSchemas = {
  usdt_trc20: z.string().trim().refine(isTronAddress, 'Expected a TRON address (T…)'),
  usdt_bep20: z.string().trim().refine(isEvmAddress, 'Expected a BSC address (0x…)'),
} as const satisfies Record<UsdtMethod, z.ZodType<string>>;

/**
 * The exact USDT to send (rule U3): the declared whole-cent amount plus the deposit's tail, in USD
 * units. `25.00` with a tail of 37 steps is `25.0037`.
 */
export function usdtPayAmount(declaredUsdUnits: number, tailUnits: number): number {
  if (!isWholeCents(declaredUsdUnits) || declaredUsdUnits <= 0) {
    throw new RangeError(`Expected a positive whole-cent amount, got ${declaredUsdUnits}`);
  }
  if (
    !Number.isInteger(tailUnits) ||
    tailUnits < USDT_TAIL_MIN_UNITS ||
    tailUnits > USDT_TAIL_MAX_UNITS ||
    tailUnits % USDT_TAIL_STEP_UNITS !== 0
  ) {
    throw new RangeError(`Expected a tail of 0.0001–0.0099, got ${tailUnits} units`);
  }
  return declaredUsdUnits + tailUnits;
}
