// Creates the database roles and the dev and test databases in a native PostgreSQL install, as
// ADR 0014 sets them up: an owner role that owns the tables and runs the migrations, and the app
// role, which owns nothing. Also run by CI and by cloud sessions.
//
//   pnpm db:setup-local              create or complete .env, then the roles and databases (psql asks
//                                    for the PostgreSQL superuser password once)
//   pnpm db:setup-local --env-only   only create or complete .env
//
// Idempotent: existing roles and databases are kept and their passwords synced with .env; keys that
// .env.example gained after .env was created are appended with fresh passwords. Anything the app
// role owns (from a single-role setup) is handed to the owner role.
// Superuser name: --superuser=NAME (default "postgres").
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const root = new URL('..', import.meta.url);
const envFile = new URL('.env', root);
const exampleFile = new URL('.env.example', root);

const randomPassword = () => randomBytes(18).toString('base64url');
const fillPasswords = (text, passwords) =>
  text.replaceAll('change-me-owner', passwords.owner).replaceAll('change-me', passwords.app);
const keyOf = (line) => /^([A-Z0-9_]+)=/.exec(line)?.[1];
const passwordOf = (url) => (url ? decodeURIComponent(new URL(url).password) : undefined);

const example = readFileSync(exampleFile, 'utf8');
if (!existsSync(envFile)) {
  writeFileSync(
    envFile,
    fillPasswords(example, { app: randomPassword(), owner: randomPassword() }),
  );
  console.warn('Created .env with random database passwords.');
} else {
  const current = readFileSync(envFile, 'utf8');
  const present = parseEnv(current);
  const missing = example.split(/\r?\n/).filter((line) => {
    const key = keyOf(line);
    return key !== undefined && !(key in present);
  });
  if (missing.length > 0) {
    const passwords = {
      app: passwordOf(present.DATABASE_URL) ?? randomPassword(),
      owner:
        passwordOf(present.DATABASE_OWNER_URL ?? present.TEST_DATABASE_OWNER_URL) ??
        randomPassword(),
    };
    const separator = current.endsWith('\n') ? '' : '\n';
    appendFileSync(
      envFile,
      `${separator}\n# Added by db:setup-local from .env.example\n${fillPasswords(missing.join('\n'), passwords)}\n`,
    );
    console.warn(`Added to .env: ${missing.map(keyOf).join(', ')}.`);
  }
}
if (process.argv.includes('--env-only')) process.exit(0);

process.loadEnvFile(envFile);
const app = new URL(requireEnv('DATABASE_URL'));
const testApp = new URL(requireEnv('TEST_DATABASE_URL'));
const owner = new URL(requireEnv('DATABASE_OWNER_URL'));
const testOwner = new URL(requireEnv('TEST_DATABASE_OWNER_URL'));
const urls = [app, testApp, owner, testOwner];

if (urls.some((url) => url.host !== app.host)) fail('All database URLs must use the same host.');
for (const [a, b] of [
  [app, testApp],
  [owner, testOwner],
]) {
  if (a.username !== b.username || a.password !== b.password) {
    fail('A role must have the same name and password in its dev and test URLs.');
  }
}
if (app.username === owner.username)
  fail('The app role and the owner role must differ (ADR 0014).');
if (app.pathname !== owner.pathname || testApp.pathname !== testOwner.pathname) {
  fail('The app and owner URLs must name the same dev and test databases.');
}

const name = (url) => decodeURIComponent(url.username);
const appRole = name(app);
const ownerRole = name(owner);
const databases = [app, testApp].map((url) => decodeURIComponent(url.pathname.slice(1)));

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const sql = [
  ...[
    [ownerRole, passwordOf(owner.href)],
    [appRole, passwordOf(app.href)],
  ].flatMap(([role, password]) => [
    `SELECT format('CREATE ROLE %I LOGIN', ${literal(role)}) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(role)})\\gexec`,
    `ALTER ROLE ${ident(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal(password)};`,
  ]),
  ...databases.map(
    (database) =>
      `SELECT format('CREATE DATABASE %I OWNER %I', ${literal(database)}, ${literal(ownerRole)}) WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${literal(database)})\\gexec`,
  ),
  ...databases.flatMap((database) => [
    `\\connect ${ident(database)}`,
    `REASSIGN OWNED BY ${ident(appRole)} TO ${ident(ownerRole)};`,
    // No temporary tables for the app role: nothing may shadow a table a trigger reads.
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(database)} FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(appRole)};`,
    `GRANT USAGE ON SCHEMA public TO ${ident(appRole)};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(ownerRole)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(appRole)};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(ownerRole)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(appRole)};`,
  ]),
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
  if (result.status !== 0) fail('psql failed; the statements before the error were applied.');
} finally {
  rmSync(sqlFile, { force: true });
}

// Prove the result: connect as each role to each database (no prompt; the URL has the password).
for (const url of urls) {
  const check = spawnSync('psql', [url.href, '-tAc', 'select 1'], { encoding: 'utf8' });
  if (check.status !== 0 || check.stdout.trim() !== '1') {
    fail(`Could not connect as "${name(url)}" to ${url.pathname.slice(1)}:\n${check.stderr}`);
  }
}
console.warn(
  `Roles "${ownerRole}" (owner) and "${appRole}" (app) and databases ${databases.join(', ')} are ready. Next: pnpm db:migrate`,
);

function requireEnv(key) {
  const value = process.env[key];
  if (!value) fail(`${key} is missing from .env`);
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
