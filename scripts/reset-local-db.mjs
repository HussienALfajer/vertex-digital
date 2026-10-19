// Empties the local dev database and migrates it again, for `pnpm db:seed-local` to start from
// nothing (development only). As the owner role (ADR 0014): drops the `public`, `drizzle` and
// `pgboss` schemas, recreates `public` and `pgboss` with the app role's grants as
// `db:setup-local` sets them, runs `pnpm db:migrate`, and removes the local files and the fake
// supplier's state. Stop `pnpm dev` first: the API and the worker hold connections and jobs.
//
//   pnpm db:reset-local --yes
//
// Refused unless the database is on this machine (localhost, 127.0.0.1, ::1) and named in .env as
// DATABASE_OWNER_URL; the test databases are never touched.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = parseEnv(readFileSync(resolve(root, '.env'), 'utf8'));

if (!process.argv.includes('--yes')) {
  fail('This deletes every row of the local dev database. Run again with --yes.');
}
if (env.NODE_ENV === 'production') fail('db:reset-local is for development only.');
const owner = new URL(requireEnv('DATABASE_OWNER_URL'));
const app = new URL(requireEnv('DATABASE_URL'));
if (!['localhost', '127.0.0.1', '[::1]'].includes(owner.hostname)) {
  fail(`Refused: the database host "${owner.hostname}" is not this machine.`);
}
if (owner.pathname !== app.pathname)
  fail('DATABASE_URL and DATABASE_OWNER_URL name other databases.');

const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const ownerRole = ident(decodeURIComponent(owner.username));
const appRole = ident(decodeURIComponent(app.username));
const sql = [
  'DROP SCHEMA IF EXISTS drizzle CASCADE;',
  'DROP SCHEMA IF EXISTS pgboss CASCADE;',
  'DROP SCHEMA IF EXISTS public CASCADE;',
  `CREATE SCHEMA public AUTHORIZATION ${ownerRole};`,
  `GRANT USAGE ON SCHEMA public TO ${appRole};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};`,
  `CREATE SCHEMA pgboss AUTHORIZATION ${ownerRole};`,
  `GRANT USAGE ON SCHEMA pgboss TO ${appRole};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};`,
].join('\n');

run('psql', [owner.href, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
run('pnpm db:migrate', [], { shell: true });

// The files and the fake supplier's state belong to the rows just dropped.
const files = resolve(root, 'apps/api', env.FILES_ROOT ?? './.data/files');
const fakeState = resolve(
  root,
  'apps/worker',
  env.FAKE_SUPPLIER_STATE_FILE ?? './.data/fake-supplier.json',
);
for (const path of [files, fakeState]) rmSync(path, { recursive: true, force: true });
console.warn('The local dev database is empty and migrated. Next: pnpm db:seed-local');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed.`);
}

function requireEnv(key) {
  const value = env[key];
  if (!value) fail(`${key} is missing from .env`);
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
