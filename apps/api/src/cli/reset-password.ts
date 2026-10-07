/**
 * Sets a new generated password for the admin, printed once, to be changed at the next sign-in,
 * and signs the admin out everywhere; TOTP stays enrolled (ADR 0016, S01 rule D2).
 *
 *   pnpm --filter @vertex-digital/api admin:reset-password --email admin@example.com
 */
import { parseArgs } from 'node:util';
import { createDatabase, loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { AdminAccountError, resetAdminPassword } from '../modules/admin/index.js';

loadRootEnv();

const { values } = parseArgs({ options: { email: { type: 'string' } } });
const parsed = z.object({ email: z.email() }).safeParse(values);
if (!parsed.success) {
  console.error(`Usage: admin:reset-password --email <email>\n\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Run `pnpm db:setup-local` (see README).');
  process.exit(1);
}

const { db, close } = createDatabase(databaseUrl);
try {
  const { password } = await resetAdminPassword(db, parsed.data.email);
  process.stdout.write(
    `New password for ${parsed.data.email} (shown once): ${password}\n` +
      'Signed out everywhere. Sign in and change it; the authenticator app stays the same.\n',
  );
} catch (error) {
  if (!(error instanceof AdminAccountError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
