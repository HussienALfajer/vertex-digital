/**
 * Removes the admin's TOTP after a lost device and signs the admin out everywhere (ADR 0016):
 * recovery on the server. The admin enrols again at the next sign-in.
 *
 *   pnpm --filter @vertex-digital/api admin:reset-two-factor --email admin@example.com
 */
import { parseArgs } from 'node:util';
import { createDatabase, loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { AdminAccountError, resetAdminTwoFactor } from '../modules/admin/index.js';

loadRootEnv();

const { values } = parseArgs({ options: { email: { type: 'string' } } });
const parsed = z.object({ email: z.email() }).safeParse(values);
if (!parsed.success) {
  console.error(
    `Usage: admin:reset-two-factor --email <email>\n\n${z.prettifyError(parsed.error)}`,
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Run `pnpm db:setup-local` (see README).');
  process.exit(1);
}

const { db, close } = createDatabase(databaseUrl);
try {
  await resetAdminTwoFactor(db, parsed.data.email);
  process.stdout.write(
    `Two-factor sign-in reset for ${parsed.data.email}; signed out everywhere.\n`,
  );
} catch (error) {
  if (!(error instanceof AdminAccountError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
