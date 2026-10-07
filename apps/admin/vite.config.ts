import { createReadStream, existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Read the API address from the root .env without Vite's loadEnv, which would also apply the
// file's NODE_ENV to this build. Nothing from that file reaches the browser bundle.
const rootEnvFile = new URL('../../.env', import.meta.url);
const rootEnv = existsSync(rootEnvFile) ? parseEnv(readFileSync(rootEnvFile, 'utf8')) : {};
const apiHost = process.env.API_HOST ?? rootEnv.API_HOST ?? '127.0.0.1';
const apiPort = process.env.API_PORT ?? rootEnv.API_PORT ?? '3000';

const MADANI_MODULE = 'virtual:madani-fonts';

/**
 * The licensed Madani Arabic files (ADR 0012), never bundled into the build. Dev and preview serve
 * them at /fonts/madani/ from the git-ignored brand/fonts/private/; production serves them from a
 * server path outside the repository, which the deploy passes as `MADANI_FONTS_DIR`. The
 * `virtual:madani-fonts` module loads their @font-face rules only when the files exist when the
 * app is built or served, so a missing font never costs a failed request: Arabic then renders in
 * Noto Kufi Arabic.
 */
function madaniFonts(): Plugin {
  const fontsDir =
    process.env.MADANI_FONTS_DIR ??
    fileURLToPath(new URL('../../brand/fonts/private/', import.meta.url));
  const available = existsSync(join(fontsDir, 'MadaniArabic-Regular.woff2'));
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    const file = join(fontsDir, basename(req.url ?? ''));
    if (!file.endsWith('.woff2') || !existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', 'font/woff2');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'vertex-madani-fonts',
    resolveId: (id) => (id === MADANI_MODULE ? `\0${MADANI_MODULE}` : undefined),
    load: (id) =>
      id === `\0${MADANI_MODULE}`
        ? available
          ? "import '@vertex-digital/ui/madani.css';"
          : 'export {};'
        : undefined,
    configureServer: (server) => void server.middlewares.use('/fonts/madani', serve),
    configurePreviewServer: (server) => void server.middlewares.use('/fonts/madani', serve),
  };
}

export default defineConfig({
  // The router plugin must run before the React plugin.
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    madaniFonts(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://${apiHost}:${apiPort}` },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
