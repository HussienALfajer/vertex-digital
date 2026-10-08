import { describe, expect, it } from 'vitest';
import {
  isEvmAddress,
  isTronAddress,
  isUsdtMethod,
  normalizeTxid,
  txidSchema,
  USDT_NETWORKS,
  usdtAddressSchemas,
  usdtPayAmount,
} from './usdt.js';

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const USD = 1_000_000;

describe('TXIDs (rule U8)', () => {
  it.each([
    HASH,
    HASH.toUpperCase(),
    `0x${HASH}`,
    `0X${HASH.toUpperCase()}`,
    `  ${HASH}\n`,
    `https://tronscan.org/#/transaction/${HASH}`,
    `https://tronscan.io/transaction/${HASH}/overview`,
    `tronscan.org/#/transaction/${HASH}?lang=ar`,
    `https://bscscan.com/tx/0x${HASH}`,
    `HTTPS://WWW.BSCSCAN.COM/TX/0X${HASH.toUpperCase()}#eventlog`,
  ])('normalizes %s', (input) => {
    expect(normalizeTxid(input)).toBe(HASH);
    expect(txidSchema.parse(input)).toBe(HASH);
  });

  it.each([
    '',
    HASH.slice(1),
    `${HASH}0`,
    `0x${HASH.slice(2)}zz`,
    `https://etherscan.io/tx/0x${HASH}`,
    `https://tronscan.org.evil.example/#/transaction/${HASH}`,
    `https://bscscan.com/address/0x${HASH}`,
    `https://bscscan.com/tx/0x${HASH}extra`,
  ])('refuses %j', (input) => {
    expect(normalizeTxid(input)).toBeNull();
    expect(txidSchema.safeParse(input).success).toBe(false);
  });

  it('refuses text longer than any link', () => {
    expect(txidSchema.safeParse(`${'x'.repeat(300)}${HASH}`).success).toBe(false);
  });
});

describe('receiving addresses (rule U1)', () => {
  it('accepts the official contracts, which pass their checksums', () => {
    expect(isTronAddress(USDT_NETWORKS.usdt_trc20.contract)).toBe(true);
    expect(isEvmAddress(USDT_NETWORKS.usdt_bep20.contract)).toBe(true);
    expect(usdtAddressSchemas.usdt_trc20.parse(` ${USDT_NETWORKS.usdt_trc20.contract} `)).toBe(
      USDT_NETWORKS.usdt_trc20.contract,
    );
  });

  it('refuses a TRON address with a wrong checksum, length, prefix or character', () => {
    const contract = USDT_NETWORKS.usdt_trc20.contract;
    expect(isTronAddress(`${contract.slice(0, -1)}u`)).toBe(false);
    expect(isTronAddress(contract.slice(0, -1))).toBe(false);
    expect(isTronAddress(`T${'0'.repeat(33)}`)).toBe(false);
    expect(isTronAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toBe(false);
    // The TRON shape, but a prefix byte other than 0x41.
    expect(isTronAddress(`T${'1'.repeat(33)}`)).toBe(false);
    expect(isTronAddress(`T${'z'.repeat(33)}`)).toBe(false);
    expect(usdtAddressSchemas.usdt_trc20.safeParse('0x0000').success).toBe(false);
  });

  it('accepts EIP-55, all-lower and all-upper BSC addresses, and refuses a bad checksum', () => {
    const contract = USDT_NETWORKS.usdt_bep20.contract;
    expect(isEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(true);
    expect(isEvmAddress(contract.toLowerCase())).toBe(true);
    expect(isEvmAddress(`0x${contract.slice(2).toUpperCase()}`)).toBe(true);
    expect(isEvmAddress(contract.replace('fF', 'Ff'))).toBe(false);
    expect(isEvmAddress(contract.slice(0, -1))).toBe(false);
    expect(isEvmAddress(contract.slice(2))).toBe(false);
    expect(usdtAddressSchemas.usdt_bep20.safeParse(USDT_NETWORKS.usdt_trc20.contract).success).toBe(
      false,
    );
  });
});

describe('networks', () => {
  it('know their methods and explorer links', () => {
    expect(isUsdtMethod('usdt_bep20')).toBe(true);
    expect(isUsdtMethod('sham_cash')).toBe(false);
    expect(USDT_NETWORKS.usdt_trc20.explorerTxUrl(HASH)).toBe(
      `https://tronscan.org/#/transaction/${HASH}`,
    );
    expect(USDT_NETWORKS.usdt_bep20.explorerTxUrl(HASH)).toBe(`https://bscscan.com/tx/0x${HASH}`);
  });
});

describe('the exact amount (rule U3)', () => {
  it('adds the tail to the declared whole cents', () => {
    expect(usdtPayAmount(25 * USD, 3_700)).toBe(25_003_700);
    expect(usdtPayAmount(5 * USD, 100)).toBe(5_000_100);
    expect(usdtPayAmount(5 * USD, 9_900)).toBe(5_009_900);
  });

  it.each([
    [25 * USD + 1, 100],
    [0, 100],
    [-USD, 100],
    [25 * USD, 0],
    [25 * USD, 10_000],
    [25 * USD, 150],
    [25 * USD, 100.5],
  ])('refuses %d with a tail of %d', (declared, tail) => {
    expect(() => usdtPayAmount(declared, tail)).toThrow(RangeError);
  });
});
