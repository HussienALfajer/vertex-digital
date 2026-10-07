/**
 * Creates the one admin account with a generated password, printed once (ADR 0016). Refuses when
 * an admin exists. TOTP is enrolled at the first sign-in.
 *
 *   pnpm --filter @vertex-digital/api admin:create --email admin@example.com --name "Name"
 */
import { parseArgs } from 'node:util';
import { createDatabase, loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { AdminAccountError, createAdmin } from '../modules/admin/index.js';

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
  console.error(`Usage: admin:create --email <email> --name <name>\n
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
  const { password } = await createAdmin(db, parsed.data);
  process.stdout.write(
    `Created the admin ${parsed.data.email}.\nPassword (shown once): ${password}\n` +
      'Sign in to the admin panel and enrol TOTP; every admin route asks for it until then.\n',
  );
} catch (error) {
  if (!(error instanceof AdminAccountError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
