#!/usr/bin/env node
// Writes a Brotli and a gzip copy beside each hashed script and style of a build, at full strength,
// for nginx's `brotli_static` and `gzip_static` (the compression snippets): the files never change,
// so they cost the deploy a few seconds once rather than the server's CPU per request at a lower
// level. Run by deploy.sh with the build's static folders. A file under a kilobyte is left alone.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const MIN_BYTES = 1024;

function compress(path) {
  const bytes = readFileSync(path);
  writeFileSync(
    `${path}.br`,
    brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  );
  writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
}

for (const root of process.argv.slice(2)) {
  for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const path = join(root, name);
    if (/\.(?:js|css)$/.test(name) && statSync(path).size >= MIN_BYTES) compress(path);
  }
}
