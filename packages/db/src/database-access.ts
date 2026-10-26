/**
 * The access ADR 0014 gives the app role on a database the owner role owns: connect, use the
 * public schema, and select, insert, update and delete on every table the owner creates there
 * (append-only tables take the changes back in their migrations); pg-boss's schema likewise. No
 * temporary tables for anyone but the owner: nothing may shadow a table a trigger reads. The owner
 * role may run these on a database it owns. Shared with scripts/setup-local-db.mjs, which runs them
 * as the superuser: it imports nothing local.
 */
export function databaseAccessStatements(database: string, owner: string, app: string): string[] {
  const [db, ownerRole, appRole] = [database, owner, app].map(
    (name) => `"${name.replaceAll('"', '""')}"`,
  );
  return [
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE ${db} TO ${appRole};`,
    `GRANT USAGE ON SCHEMA public TO ${appRole};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};`,
    // pg-boss's tables: installed by the owner with the migrations, used by the app role.
    `CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${ownerRole};`,
    `GRANT USAGE ON SCHEMA pgboss TO ${appRole};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};`,
  ];
}
