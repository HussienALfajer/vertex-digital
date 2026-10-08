/**
 * Adds a transaction to the fake chain (S04, development only: refused unless CHAIN_READER=fake),
 * for the owner's local acceptance. By default it sends official USDT to the store's address of
 * the network, final at once; the worker's scanner then finds it.
 *
 *   pnpm --filter @vertex-digital/worker usdt:fake-transfer --method usdt_trc20 --amount 25.0037 \
 *     [--txid <hex>] [--to <address>] [--contract <address>] [--failed]
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  normalizeTxid,
  tronAddressFromHex,
  USDT_METHODS,
  USDT_NETWORKS,
} from '@vertex-digital/contracts';
import { loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { parseEnv } from '../core/config/env.js';
import { FileFakeChainStore } from '../jobs/deposits/chain/fake-reader.js';

/** A decimal amount in the token's raw units, exactly (never through a float). */
function rawAmount(text: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  return BigInt(`${match[1]}${fraction.padEnd(decimals, '0')}`);
}

const argsSchema = z.object({
  method: z.enum(USDT_METHODS),
  amount: z.string(),
  txid: z.string().optional(),
  to: z.string().optional(),
  contract: z.string().optional(),
  from: z.string().optional(),
  failed: z.boolean().optional(),
});

loadRootEnv();
const env = parseEnv();
const { values } = parseArgs({
  options: {
    method: { type: 'string' },
    amount: { type: 'string' },
    txid: { type: 'string' },
    to: { type: 'string' },
    contract: { type: 'string' },
    from: { type: 'string' },
    failed: { type: 'boolean' },
  },
});
const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error(`Usage: usdt:fake-transfer --method <usdt_trc20|usdt_bep20> --amount <25.0037>
  [--txid <hex>] [--to <address>] [--contract <address>] [--from <address>] [--failed]\n
${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
if (env.CHAIN_READER !== 'fake') {
  console.error('CHAIN_READER is not `fake`: the fake chain is for development only.');
  process.exit(1);
}
const args = parsed.data;
const network = USDT_NETWORKS[args.method];
const raw = rawAmount(args.amount, network.decimals);
const txid = args.txid === undefined ? randomBytes(32).toString('hex') : normalizeTxid(args.txid);
const to =
  args.to ?? (args.method === 'usdt_trc20' ? env.USDT_TRC20_ADDRESS : env.USDT_BEP20_ADDRESS);
if (raw === null || raw <= 0n || txid === null || to === undefined) {
  console.error(
    raw === null || raw <= 0n
      ? `--amount must be a positive number with at most ${network.decimals} decimals`
      : txid === null
        ? '--txid must be a 64-hex TXID or an explorer link'
        : `No address for ${args.method}: set it in .env or pass --to`,
  );
  process.exit(1);
}
const from =
  args.from ??
  (args.method === 'usdt_trc20'
    ? (tronAddressFromHex(`${'0'.repeat(38)}01`) as string)
    : '0x0000000000000000000000000000000000000001');
const added = await new FileFakeChainStore(env.FAKE_CHAIN_FILE).add({
  method: args.method,
  txid,
  status: args.failed ? 'failed' : 'succeeded',
  final: true,
  transfers: args.failed
    ? []
    : [{ contract: args.contract ?? network.contract, from, to, raw: raw.toString() }],
});
process.stdout.write(
  `Added ${args.method} transaction ${added.txid} (block ${added.blockNumber}${args.failed ? ', failed' : ''}).\n`,
);
