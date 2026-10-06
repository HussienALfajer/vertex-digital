/**
 * Creates the first owner with a generated password, printed once (ADR 0007). Refuses when an
 * active owner exists; later staff are added in the panel (F02). TOTP is enrolled at first sign-in.
 *
 *   pnpm --filter @vertex-digital/api staff:create-owner --email owner@example.com --name "Name"
 */
import { parseArgs } from 'node:util';
import { createDatabase, loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { createFirstOwner, StaffAccountError } from '../modules/staff/index.js';

const argsSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(100),
});

loadRootEnv();

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' } },
});
const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error(`Usage: staff:create-owner --email <email> --name <name>\n
${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Run `pnpm db:setup-local` (see README).');
  process.exit(1);
}

const { db, close } = createDatabase(databaseUrl);
try {
  const { password } = await createFirstOwner(db, parsed.data);
  process.stdout.write(
    `Created the owner ${parsed.data.email}.\nPassword (shown once): ${password}\n` +
      'Sign in to the admin panel and enrol TOTP; every staff route asks for it until then.\n',
  );
} catch (error) {
  if (!(error instanceof StaffAccountError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
