/**
 * Scripts the fake chain's USDT balance of the store's address (S13, development only: refused
 * unless CHAIN_READER=fake), for the owner's local acceptance. The balance the reconciliation
 * reads is the fake transfers to and from the address plus this offset: money moved in or out
 * outside the deposit flow. `--adjust` adds to the offset (negative takes from it); `--reset` sets
 * it back to 0.
 *
 *   pnpm --filter @vertex-digital/worker usdt:fake-balance --method usdt_trc20 --adjust 10
 *   pnpm --filter @vertex-digital/worker usdt:fake-balance --method usdt_trc20 --adjust -20
 *   pnpm --filter @vertex-digital/worker usdt:fake-balance --method usdt_bep20 --reset
 */
import { parseArgs } from 'node:util';
import { USDT_METHODS, USDT_NETWORKS, type UsdtMethod } from '@vertex-digital/contracts';
import { loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { parseEnv } from '../core/config/env.js';
import { FakeReader, FileFakeChainStore } from '../jobs/deposits/chain/fake-reader.js';

/** At most 6 decimals: USD units are micro-dollars. */
const ADJUST_DECIMALS = 6;

/** A signed decimal USD amount in the token's raw units, exactly (never through a float). */
function rawAdjustment(text: string, method: UsdtMethod): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[3] ?? '';
  if (fraction.length > ADJUST_DECIMALS) return null;
  const decimals = USDT_NETWORKS[method].decimals;
  const raw = BigInt(`${match[2]}${fraction.padEnd(decimals, '0')}`);
  return match[1] === '-' ? -raw : raw;
}

/** A raw amount as a decimal USDT text. */
function usdtText(raw: bigint, method: UsdtMethod): string {
  const decimals = USDT_NETWORKS[method].decimals;
  const sign = raw < 0n ? '-' : '';
  const digits = (raw < 0n ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

const argsSchema = z
  .object({
    method: z.enum(USDT_METHODS),
    adjust: z.string().optional(),
    reset: z.boolean().optional(),
  })
  .refine((args) => (args.adjust === undefined) !== (args.reset === undefined), {
    message: 'Pass exactly one of --adjust and --reset',
  });

loadRootEnv();
const env = parseEnv();
// `--adjust -20`: a negative amount is the option's value, not another option.
const argv: string[] = [];
const given = process.argv.slice(2);
for (let index = 0; index < given.length; index += 1) {
  const arg = given[index] as string;
  const next = given[index + 1];
  if (arg === '--adjust' && next !== undefined) {
    argv.push(`--adjust=${next}`);
    index += 1;
  } else {
    argv.push(arg);
  }
}
const { values } = parseArgs({
  args: argv,
  options: {
    method: { type: 'string' },
    adjust: { type: 'string' },
    reset: { type: 'boolean' },
  },
});
const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error(`Usage: usdt:fake-balance --method <usdt_trc20|usdt_bep20> --adjust <±usd> | --reset\n
${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
if (env.CHAIN_READER !== 'fake') {
  console.error('CHAIN_READER is not `fake`: the fake chain is for development only.');
  process.exit(1);
}
const args = parsed.data;
const raw = args.adjust === undefined ? null : rawAdjustment(args.adjust, args.method);
if (args.adjust !== undefined && raw === null) {
  console.error(`--adjust must be a number with at most ${ADJUST_DECIMALS} decimals`);
  process.exit(1);
}
const address = args.method === 'usdt_trc20' ? env.USDT_TRC20_ADDRESS : env.USDT_BEP20_ADDRESS;
const store = new FileFakeChainStore(env.FAKE_CHAIN_FILE);
const offset = await store.adjustOffset(args.method, raw);
const balance =
  address === undefined ? null : await new FakeReader(args.method, store).getUsdtBalance(address);
process.stdout.write(
  `${args.method}: offset ${usdtText(offset, args.method)} USDT${
    balance === null
      ? ' (no store address in .env: no balance to read)'
      : `, balance read by the worker ${usdtText(balance, args.method)} USDT`
  }.\n`,
);
