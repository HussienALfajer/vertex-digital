import { PgBoss } from 'pg-boss';

/*
 * pg-boss, the job queue of the API and the worker (ADR 0002), under the role split of ADR 0014:
 * the owner role installs and upgrades its tables with the migrations; the app role only uses
 * them. The `pgboss` schema itself, owned by the owner role with default privileges for the app
 * role, is made by the database setup (`scripts/setup-local-db.mjs`, the production provisioning).
 */

export const PG_BOSS_SCHEMA = 'pgboss';

/**
 * A pg-boss instance for an app process (app role). It never creates or migrates tables and never
 * rebuilds indexes, which needs the owner; queues are created unpartitioned, as rows only.
 * `supervise` and `schedule` stay on by default: the worker runs maintenance and the cron.
 */
export function createPgBoss(
  connectionString: string,
  options: { supervise?: boolean; schedule?: boolean } = {},
): PgBoss {
  return new PgBoss({
    connectionString,
    schema: PG_BOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    reindex: false,
    ...options,
  });
}

/** Installs or upgrades the pg-boss tables as the owner role; part of `runMigrations`. */
export async function installPgBoss(ownerConnectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerConnectionString,
    schema: PG_BOSS_SCHEMA,
    migrate: true,
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  await boss.stop({ graceful: false });
}
