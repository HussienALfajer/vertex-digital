/**
 * Removes a staff member's TOTP after a lost device and signs them out everywhere (ADR 0007): the
 * owner's recovery on the server. They enrol again at their next sign-in.
 *
 *   pnpm --filter @vertex-digital/api staff:reset-two-factor --email owner@example.com
 */
import { parseArgs } from 'node:util';
import { createDatabase, loadRootEnv } from '@vertex-digital/db';
import { z } from 'zod';
import { resetStaffTwoFactor, StaffAccountError } from '../modules/staff/index.js';

loadRootEnv();

const { values } = parseArgs({ options: { email: { type: 'string' } } });
const parsed = z.object({ email: z.email() }).safeParse(values);
if (!parsed.success) {
  console.error(
    `Usage: staff:reset-two-factor --email <email>\n\n${z.prettifyError(parsed.error)}`,
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
  await resetStaffTwoFactor(db, parsed.data.email);
  process.stdout.write(
    `Two-factor sign-in reset for ${parsed.data.email}; signed out everywhere.\n`,
  );
} catch (error) {
  if (!(error instanceof StaffAccountError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
