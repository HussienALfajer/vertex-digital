/**
 * Applies pending migrations as the owner role (ADR 0014), using DATABASE_OWNER_URL from the
 * environment or the root .env.
 * Production deploys run this from the built package, without drizzle-kit:
 *
 *   node packages/db/dist/cli/migrate.js
 */
import { loadRootEnv } from '../env.js';
import { runMigrations } from '../migrate.js';

loadRootEnv();

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is not set.');
  process.exit(1);
}

await runMigrations(url);
process.stdout.write('Migrations are up to date.\n');
