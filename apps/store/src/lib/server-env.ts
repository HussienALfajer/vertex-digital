import { createHash } from 'node:crypto';

/*
 * The store server's own settings, from the root .env (src/instrumentation.ts). Server code only:
 * nothing here reaches a browser bundle.
 */

/** How the store's server components reach the API: never through the public host. */
export function apiInternalUrl(): string {
  return process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3000';
}

/** The store's public origin (`STORE_URL`), for absolute links: the sitemap, Open Graph images. */
export function storeUrl(): string {
  return (process.env.STORE_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
}

/** A value `.env.example` ships (never a real secret) counts as unset, as for the worker. */
const isPlaceholder = (value: string) =>
  value.startsWith('replace-') || value.includes('replace-me');

/**
 * The bearer token of `POST /_internal/revalidate` (S09 rule SF4), shared with the worker: at
 * least 32 characters, required in production. Outside production, unset or the placeholder, it
 * is derived from `DATABASE_URL` exactly as the worker derives it, so `pnpm dev` needs no setup.
 */
export function revalidateSecret(): string {
  const value = process.env.STORE_REVALIDATE_SECRET;
  if (value && !isPlaceholder(value)) {
    if (value.length < 32)
      throw new Error('STORE_REVALIDATE_SECRET must be at least 32 characters');
    return value;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('STORE_REVALIDATE_SECRET is required');
  return createHash('sha256')
    .update(`vertex-digital-dev-store-revalidate:${process.env.DATABASE_URL ?? ''}`)
    .digest('base64');
}
