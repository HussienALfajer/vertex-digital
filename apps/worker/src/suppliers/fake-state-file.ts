import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type FakeOrder,
  type FakeSupplierState,
  fakeSupplierStateSchema,
} from '@vertex-digital/suppliers';

/*
 * The fake supplier's scripted state (S07, development and E2E): a git-ignored JSON file
 * (`FAKE_SUPPLIER_STATE_FILE`) the `supplier:fake` CLI writes and the registry reads at every
 * call. No file is the plain catalog. S08: the fake's orders live there too, so polls, repeated
 * keys and `supplier:fake --resolve` find them across calls.
 */

export async function readFakeSupplierState(path: string): Promise<FakeSupplierState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return fakeSupplierStateSchema.parse({});
    throw error;
  }
  return fakeSupplierStateSchema.parse(JSON.parse(text));
}

/** Written whole, then renamed: a reader never sees half a file. */
export async function writeFakeSupplierState(
  path: string,
  state: FakeSupplierState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

/** One change at a time in this process: two jobs keeping orders never lose one another's. */
let queue: Promise<unknown> = Promise.resolve();

/** Re-reads the file and writes it back with `change` applied, one change at a time. */
export function updateFakeSupplierState(
  path: string,
  change: (state: FakeSupplierState) => FakeSupplierState,
): Promise<FakeSupplierState> {
  const next = queue.then(async () => {
    const state = change(await readFakeSupplierState(path));
    await writeFakeSupplierState(path, state);
    return state;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Keeps one fake order (S08), as the adapter's `onOrder`. */
export async function keepFakeOrder(path: string, key: string, order: FakeOrder): Promise<void> {
  await updateFakeSupplierState(path, (state) => ({
    ...state,
    orders: { ...state.orders, [key]: order },
  }));
}
