/**
 * Fills the local dev database with a full store to test by hand (development only: refused in
 * production and for a database on another machine): the production catalog from a snapshot
 * (`scripts/pull-catalog-snapshot.sh`) with every WDGZone pack mirrored on the fake supplier and
 * WDGZone paused, then customers, wallets, deposits, orders in every state, admin decisions,
 * tickets, content, treasury and reconciliation, all through the API's services. Run it on an
 * empty database (`pnpm db:reset-local --yes`) with `pnpm dev` running, since the worker fulfils
 * the orders against the fake supplier while the seed waits.
 *
 *   pnpm db:seed-local [--catalog <snapshot dir>] [--admin-email <email>] [--admin-name <name>]
 *
 * Prints the customers' shared password, and the admin's password when it creates the admin.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { createDatabase, loadRootEnv, setupMerchantTiers } from '@vertex-digital/db';
import { type FakeSupplierState, fakeSupplierStateSchema } from '@vertex-digital/suppliers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { parseEnv } from '../core/config/env.js';
import { routingContext } from '../core/config/routing-context.js';
import { JobsService } from '../core/jobs/index.js';
import { createAdmin, theAdmin } from '../modules/admin/index.js';
import { FileStorage } from '../modules/files/index.js';
import { SettingsService } from '../modules/settings/index.js';
import { SuppliersService } from '../modules/suppliers/index.js';
import { loadCatalog, repriceCatalog } from './seed/catalog.js';
import { Scenarios } from './seed/scenarios.js';

loadRootEnv();
// The seed's purchases and its repricing route through the fake supplier.
process.env.SUPPLIER_FAKE_ENABLED ??= 'true';

const { values } = parseArgs({
  options: {
    catalog: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
  },
});
const args = z
  .object({
    catalog: z.string().min(1).default('../../storage/catalog-snapshot'),
    'admin-email': z.email().default('admin@example.com'),
    'admin-name': z.string().trim().min(1).max(100).default('مدير المتجر'),
  })
  .parse(values);

const env = parseEnv();
const log = (line: string) => process.stdout.write(`${line}\n`);
const fail = (message: string) => {
  console.error(message);
  process.exit(1);
};
if (env.NODE_ENV === 'production') fail('db:seed-local is for development only.');
if (!env.SUPPLIER_FAKE_ENABLED) fail('db:seed-local needs SUPPLIER_FAKE_ENABLED=true.');
const host = new URL(env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
  fail(`Refused: the database host "${host}" is not this machine.`);
}

const { db, close } = createDatabase(env.DATABASE_URL);
const seeded = await db.execute(
  sql`SELECT 1 FROM customers WHERE email = 'ahmad.halabi@example.com'`,
);
if (seeded.rows.length > 0) {
  await close();
  fail('This database is seeded already. Start again from nothing: pnpm db:reset-local --yes');
}
// A real supplier's key here would let the copied routes spend its real balance: never seed then.
const keyed = await db.execute<{ code: string }>(
  sql`SELECT DISTINCT s.code FROM supplier_credentials c JOIN suppliers s ON s.id = c.supplier_id
    WHERE s.code NOT IN ('fake', 'manual')`,
);
if (keyed.rows.length > 0) {
  await close();
  fail(
    `Refused: ${keyed.rows.map((row) => row.code).join(', ')} has a key in this database. Start again from nothing: pnpm db:reset-local --yes`,
  );
}

let admin = await theAdmin(db);
let adminPassword: string | undefined;
if (!admin) {
  const created = await createAdmin(db, { email: args['admin-email'], name: args['admin-name'] });
  admin = { id: created.id, name: args['admin-name'], email: args['admin-email'] };
  adminPassword = created.password;
}

// The fake supplier's state lives where the worker reads it (as the API resolves it).
const statePath = isAbsolute(env.FAKE_SUPPLIER_STATE_FILE)
  ? env.FAKE_SUPPLIER_STATE_FILE
  : resolve('..', 'worker', env.FAKE_SUPPLIER_STATE_FILE);
async function changeState(change: (state: FakeSupplierState) => FakeSupplierState) {
  let state = fakeSupplierStateSchema.parse({});
  try {
    state = fakeSupplierStateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  // Checked as the worker reads it: a state it refuses would fail every fake call.
  const next = fakeSupplierStateSchema.parse(change(state));
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, statePath);
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
try {
  const actor = { adminId: admin.id, meta: { ipAddress: '127.0.0.1', userAgent: 'db:seed-local' } };
  // WDGZone is paused before any of its routes exist; a refusal stops the seed.
  await app
    .get(SettingsService, { strict: false })
    .change(admin.id, { switch: 'wdgzone_paused', value: true }, 'admin', actor.meta);
  log(`Catalog from ${resolve(args.catalog)}`);
  const catalog = await loadCatalog(db, app.get(FileStorage, { strict: false }), {
    dir: resolve(args.catalog),
    adminId: admin.id,
    now: new Date(),
  });
  for (const [table, count] of Object.entries(catalog.rows)) log(`  ${table}: ${count}`);
  log(`  ${catalog.mirrored} WDGZone packs mirrored on the fake supplier`);
  await changeState((state) => ({ ...state, mirroredOffers: catalog.mirroredOffers }));
  await app.get(SuppliersService, { strict: false }).setCredentials(actor, 'fake', {
    values: { webhookSecret: randomBytes(24).toString('base64url') },
  });
  log(`  ${await repriceCatalog(db, new Date())} products repriced`);
  // S23 PX1: the tiers, their lists and levels, as production gets them after the deploy.
  const tiers = await setupMerchantTiers(db, {
    jobs: app.get(JobsService, { strict: false }),
    routing: routingContext(env),
  });
  log(`Merchant tiers: ${tiers.lines.length} steps, ${tiers.listRowsAppended} list rows`);

  const customerPassword = randomBytes(9).toString('base64url');
  const report = await new Scenarios(app, db, {
    adminId: admin.id,
    adminName: admin.name,
    adminEmail: admin.email,
    customerPassword,
    fakeState: {
      setScripts: (scripts) =>
        changeState((state) => ({
          ...state,
          orderScripts: fakeSupplierStateSchema.shape.orderScripts.parse(scripts),
        })),
      setCost: (offerId, units) =>
        changeState((state) => ({ ...state, costs: { ...state.costs, [offerId]: units } })),
    },
    log,
  }).run();
  // The price review appears once the fake's next sync reads the new cost.
  await app.get(SuppliersService, { strict: false }).requestSync(actor, 'fake');

  log(`\nDone: ${report.steps} steps, ${report.skipped.length} skipped.`);
  for (const line of report.skipped) log(`  skipped ${line}`);
  log('\nCustomers (one password for all, shown once):');
  for (const customer of report.customers) {
    log(`  ${customer.email}  ${customer.name}${customer.test ? '  (test customer)' : ''}`);
  }
  log(`  password: ${customerPassword}`);
  if (adminPassword) {
    log(
      `\nAdmin ${admin.email} created; password (shown once, change it at the first sign-in): ${adminPassword}`,
    );
  }
} finally {
  await app.close();
  await close();
}
