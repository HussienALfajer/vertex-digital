import { resolve } from 'node:path';
import { revalidateSecret } from './lib/server-env';

/*
 * The store's server components read the API (`API_INTERNAL_URL`) and the worker calls its
 * revalidation route (`STORE_REVALIDATE_SECRET`), both from the repository's root .env, as the API
 * and the worker load it: Next.js reads only this app's folder. Variables already set in the
 * environment win (the E2E servers set their own). The store runs from apps/store, in development
 * and under PM2 (deploy/ecosystem.config.cjs).
 */
try {
  process.loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// Production refuses to start without the revalidation secret (the build needs none).
if (process.env.NEXT_PHASE !== 'phase-production-build') revalidateSecret();
