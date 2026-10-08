/**
 * Scripts the fake supplier (S07, development and E2E only: refused unless
 * SUPPLIER_FAKE_ENABLED=true outside production), for the owner's local acceptance. Each call
 * makes one change to the state file (FAKE_SUPPLIER_STATE_FILE) the worker reads at every call:
 *
 *   pnpm --filter @vertex-digital/worker supplier:fake --cost <offer> <usd> | --stock <offer> on|off
 *     | --remove <offer> | --fail-sync on|off | --errors on|off | --balance <usd> | --reset
 */
import { parseArgs } from 'node:util';
import { parseUsd } from '@vertex-digital/contracts';
import { loadRootEnv } from '@vertex-digital/db';
import { type FakeSupplierState, fakeSupplierStateSchema } from '@vertex-digital/suppliers';
import { parseEnv } from '../core/config/env.js';
import { readFakeSupplierState, writeFakeSupplierState } from '../suppliers/fake-state-file.js';

const USAGE = `Usage: supplier:fake --cost <offer> <usd> | --stock <offer> on|off | --remove <offer>
  | --fail-sync on|off | --errors on|off | --balance <usd> | --reset`;

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
  },
});
if (Object.keys(values).length !== 1) fail('Give exactly one change.');

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
} else {
  next = fakeSupplierStateSchema.parse({});
}
await writeFakeSupplierState(env.FAKE_SUPPLIER_STATE_FILE, next);
process.stdout.write(`Fake supplier state (${env.FAKE_SUPPLIER_STATE_FILE}):\n`);
process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
