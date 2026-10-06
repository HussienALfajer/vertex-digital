// Creates the local development role and databases in a native PostgreSQL install.
//
//   pnpm db:setup-local              create .env if missing, then create role + databases (psql asks
//                                    for the PostgreSQL superuser password)
//   pnpm db:setup-local --env-only   only create .env
//
// Idempotent: existing role and databases are kept; the role password is synced with .env.
// Superuser name: --superuser=NAME (default "postgres").
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const envFile = new URL('.env', root);
const exampleFile = new URL('.env.example', root);

if (!existsSync(envFile)) {
  const password = randomBytes(18).toString('base64url');
  writeFileSync(envFile, readFileSync(exampleFile, 'utf8').replaceAll('change-me', password));
  console.warn('Created .env with a random database password.');
}
if (process.argv.includes('--env-only')) process.exit(0);

process.loadEnvFile(envFile);
const app = new URL(requireEnv('DATABASE_URL'));
const test = new URL(requireEnv('TEST_DATABASE_URL'));
if (app.username !== test.username || app.host !== test.host) {
  fail('DATABASE_URL and TEST_DATABASE_URL must use the same role and host.');
}

const role = decodeURIComponent(app.username);
const password = decodeURIComponent(app.password);
const databases = [app, test].map((url) => decodeURIComponent(url.pathname.slice(1)));

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const sql = [
  `SELECT format('CREATE ROLE %I LOGIN', ${literal(role)}) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(role)})\\gexec`,
  `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', ${literal(role)}, ${literal(password)})\\gexec`,
  ...databases.map(
    (name) =>
      `SELECT format('CREATE DATABASE %I OWNER %I', ${literal(name)}, ${literal(role)}) WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${literal(name)})\\gexec`,
  ),
].join('\n');

const sqlFile = join(tmpdir(), `vertex-digital-setup-${process.pid}.sql`);
writeFileSync(sqlFile, sql, { mode: 0o600 });
try {
  const args = [
    '-h',
    app.hostname,
    '-p',
    app.port || '5432',
    '-U',
    process.argv.find((arg) => arg.startsWith('--superuser='))?.slice(12) || 'postgres',
  ];
  const result = spawnSync(
    'psql',
    [...args, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', sqlFile],
    {
      stdio: 'inherit',
    },
  );
  if (result.error) fail(`Could not run psql: ${result.error.message}`);
  if (result.status !== 0) fail('psql failed; nothing else was changed.');
} finally {
  rmSync(sqlFile, { force: true });
}

// Prove the result: connect as the application role to each database (no prompt; the URL has the password).
for (const url of [app, test]) {
  const check = spawnSync('psql', [url.href, '-tAc', 'select 1'], { encoding: 'utf8' });
  if (check.status !== 0 || check.stdout.trim() !== '1') {
    fail(`Could not connect as "${role}" to ${url.pathname.slice(1)}:\n${check.stderr}`);
  }
}
console.warn(
  `Role "${role}" and databases ${databases.join(', ')} are ready. Next: pnpm db:migrate`,
);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is missing from .env`);
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
