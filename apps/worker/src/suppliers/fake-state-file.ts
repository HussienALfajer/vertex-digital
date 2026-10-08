import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type FakeSupplierState, fakeSupplierStateSchema } from '@vertex-digital/suppliers';

/*
 * The fake supplier's scripted state (S07, development and E2E): a git-ignored JSON file
 * (`FAKE_SUPPLIER_STATE_FILE`) the `supplier:fake` CLI writes and the registry reads at every
 * call. No file is the plain catalog.
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
