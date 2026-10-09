import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { revalidateSecret } from './lib/server-env';

/*
 * The store reads a few settings from the repository's root .env (in production `shared/.env`,
 * which also holds the API's and the worker's secrets). Only the names below are copied into this
 * process: the internet-facing store never holds the database password, the codes or supplier
 * keys, or the auth secrets (ADR 0008, 0014). Outside production `DATABASE_URL` is copied too, to
 * derive the revalidation secret as the worker does. Variables already set win (the E2E servers
 * set their own). The store runs from apps/store, in development and under PM2.
 */
const NEEDED = ['API_INTERNAL_URL', 'STORE_URL', 'STORE_REVALIDATE_SECRET'];
const DEVELOPMENT_ONLY = ['DATABASE_URL'];

let file: Record<string, string | undefined> = {};
try {
  file = parseEnv(readFileSync(resolve(process.cwd(), '../../.env'), 'utf8'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const names = process.env.NODE_ENV === 'production' ? NEEDED : [...NEEDED, ...DEVELOPMENT_ONLY];
for (const name of names) {
  const value = file[name];
  if (process.env[name] === undefined && value !== undefined) process.env[name] = value;
}

// Production refuses to start without the revalidation secret (the build needs none).
if (process.env.NEXT_PHASE !== 'phase-production-build') revalidateSecret();
