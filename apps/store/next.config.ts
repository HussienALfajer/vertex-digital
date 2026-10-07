import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { NextConfig } from 'next';

// The API address for development, from the root .env (Next.js reads only this app's folder).
// Nothing from that file reaches the browser bundle.
const rootEnvFile = new URL('../../.env', import.meta.url);
const rootEnv = existsSync(rootEnvFile) ? parseEnv(readFileSync(rootEnvFile, 'utf8')) : {};
const apiUrl = process.env.API_INTERNAL_URL ?? rootEnv.API_INTERNAL_URL ?? 'http://127.0.0.1:3000';

/**
 * The licensed Madani Arabic files (ADR 0012) are never bundled or committed. Production serves
 * them from a server path outside the repository (nginx, `MADANI_FONTS_DIR` at build time),
 * development from the git-ignored brand/fonts/private/ (src/app/fonts/madani/[file]/route.ts).
 * Their @font-face rules load only when the files exist when the store is built, so a missing
 * font never costs a failed request: Arabic then renders in Noto Kufi Arabic.
 */
const madaniDir =
  process.env.MADANI_FONTS_DIR ??
  fileURLToPath(new URL('../../brand/fonts/private/', import.meta.url));
const madaniAvailable = existsSync(join(madaniDir, 'MadaniArabic-Regular.woff2'));

const config: NextConfig = {
  cacheComponents: true,
  reactStrictMode: true,
  poweredByHeader: false,
  // nginx compresses (Brotli or gzip) in production.
  compress: false,
  transpilePackages: ['@vertex-digital/ui'],
  turbopack: {
    root: fileURLToPath(new URL('../../', import.meta.url)),
    resolveAlias: {
      'vertex-madani-fonts': madaniAvailable
        ? '@vertex-digital/ui/madani.css'
        : './src/app/no-madani.css',
    },
  },
  // nginx sends /api to the API in production; the development server does it here.
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
};

export default config;
