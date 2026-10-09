/**
 * Scripts the fake supplier (S07, development and E2E only: refused unless
 * SUPPLIER_FAKE_ENABLED=true outside production), for the owner's local acceptance. Each call
 * makes one change to the state file (FAKE_SUPPLIER_STATE_FILE) the worker reads at every call:
 *
 *   pnpm --filter @vertex-digital/worker supplier:fake --cost <offer> <usd> | --stock <offer> on|off
 *     | --remove <offer> | --fail-sync on|off | --errors on|off | --balance <usd> | --reset
 *     | --order <offer> delivered|pending|failed|invalid|unknown|partial:<n>|slow:<seconds>
 *     | --resolve <order number> delivered|failed --via poll|webhook
 *
 * S08: `--order` scripts how the offer's next orders answer; `--resolve` settles the order's open
 * fake attempt, so the next poll finds it (`--via poll`), or posts its signed webhook to the local
 * API (`--via webhook`, at API_HOST:API_PORT, signed with the fake's stored webhook secret).
 */
import { parseArgs } from 'node:util';
import { orderNumberSchema, parseUsd } from '@vertex-digital/contracts';
import { createDatabase, loadRootEnv, openAttempt, orders } from '@vertex-digital/db';
import {
  FakeSupplierAdapter,
  type FakeSupplierState,
  fakeOrderScriptSchema,
  fakeSupplierStateSchema,
} from '@vertex-digital/suppliers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { parseEnv } from '../core/config/env.js';
import { readFakeSupplierState, writeFakeSupplierState } from '../suppliers/fake-state-file.js';
import { SupplierRegistry } from '../suppliers/supplier-registry.js';

const USAGE = `Usage: supplier:fake --cost <offer> <usd> | --stock <offer> on|off | --remove <offer>
  | --fail-sync on|off | --errors on|off | --balance <usd> | --reset
  | --order <offer> delivered|pending|failed|invalid|unknown|partial:<n>|slow:<seconds>
  | --resolve <order number> delivered|failed --via poll|webhook`;

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

const onOff = (value: string | undefined): boolean =>
  value === 'on' ? true : value === 'off' ? false : fail('Expected on or off');

const dollars = (value: string | undefined): number => {
  const units = value === undefined ? null : parseUsd(value);
  return units === null ? fail('Expected dollars, e.g. 0.92') : units;
};

loadRootEnv();
const env = parseEnv();
if (env.NODE_ENV === 'production' || !env.SUPPLIER_FAKE_ENABLED) {
  fail('SUPPLIER_FAKE_ENABLED is not true: the fake supplier is for development only.');
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cost: { type: 'string' },
    stock: { type: 'string' },
    remove: { type: 'string' },
    'fail-sync': { type: 'string' },
    errors: { type: 'string' },
    balance: { type: 'string' },
    reset: { type: 'boolean' },
    order: { type: 'string' },
    resolve: { type: 'string' },
    via: { type: 'string' },
  },
});
const { via, ...changes } = values;
if (Object.keys(changes).length !== 1) fail('Give exactly one change.');

if (values.resolve !== undefined) {
  await resolve(values.resolve, positionals[0], via);
  process.exit(0);
}

const state = await readFakeSupplierState(env.FAKE_SUPPLIER_STATE_FILE);
const without = (list: string[], offer: string) => list.filter((item) => item !== offer);
let next: FakeSupplierState;
if (values.cost !== undefined) {
  next = { ...state, costs: { ...state.costs, [values.cost]: dollars(positionals[0]) } };
} else if (values.stock !== undefined) {
  const inStock = onOff(positionals[0]);
  next = {
    ...state,
    outOfStock: inStock
      ? without(state.outOfStock, values.stock)
      : [...without(state.outOfStock, values.stock), values.stock],
  };
} else if (values.remove !== undefined) {
  next = { ...state, removed: [...without(state.removed, values.remove), values.remove] };
} else if (values['fail-sync'] !== undefined) {
  next = { ...state, failSync: onOff(values['fail-sync']) };
} else if (values.errors !== undefined) {
  next = { ...state, errors: onOff(values.errors) };
} else if (values.balance !== undefined) {
  next = { ...state, balanceUsdUnits: dollars(values.balance) };
} else if (values.order !== undefined) {
  const script = fakeOrderScriptSchema.safeParse(positionals[0]);
  if (!script.success) fail('Expected delivered, pending, failed, invalid, unknown, partial:<n> or slow:<s>');
  next = { ...state, orderScripts: { ...state.orderScripts, [values.order]: script.data } };
} else {
  next = fakeSupplierStateSchema.parse({});
}
await writeFakeSupplierState(env.FAKE_SUPPLIER_STATE_FILE, next);
process.stdout.write(`Fake supplier state (${env.FAKE_SUPPLIER_STATE_FILE}):\n`);
process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);

/** `--resolve`: settles the order's open fake attempt, then lets a poll or a webhook report it. */
async function resolve(number: string, outcome: string | undefined, how: string | undefined) {
  const parsed = orderNumberSchema.safeParse(number);
  if (!parsed.success) fail('Expected an order number such as VO-7KQ2MX');
  if (outcome !== 'delivered' && outcome !== 'failed') fail('Expected delivered or failed');
  if (how !== 'poll' && how !== 'webhook') fail('Expected --via poll or --via webhook');
  const connection = createDatabase(env.DATABASE_URL);
  try {
    const [order] = await connection.db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.number, parsed.data));
    const open = order && (await openAttempt(connection.db, order.id));
    if (!open || open.supplierCode !== 'fake') fail(`${parsed.data} has no open fake attempt`);
    const connected = await new SupplierRegistry(env).connect(connection.db, {
      id: open.attempt.supplierId,
      code: 'fake',
    });
    if (!(connected?.adapter instanceof FakeSupplierAdapter)) {
      fail('The fake supplier has no credentials: set them in the panel first.');
    }
    const webhook = await connected.adapter.resolve(open.attempt.id, outcome);
    if (how === 'poll') {
      process.stdout.write(`${parsed.data}: ${outcome} at the next poll\n`);
      return;
    }
    const api = z
      .object({
        API_HOST: z.string().min(1).default('127.0.0.1'),
        API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      })
      .parse(process.env);
    const response = await fetch(
      `http://${api.API_HOST}:${api.API_PORT}/api/webhooks/suppliers/fake`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(webhook.headers as Record<string, string>),
        },
        body: webhook.rawBody,
      },
    );
    process.stdout.write(`${parsed.data}: ${outcome} by webhook, the API answered ${response.status}\n`);
  } finally {
    await connection.close();
  }
}
