import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const headers = readFileSync(
  new URL('../../../deploy/nginx/vertexdigital-admin-csp.conf', import.meta.url),
  'utf8',
);

describe('production Content Security Policy', () => {
  it('allows exactly the inline scripts in index.html by hash', () => {
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => {
      const digest = createHash('sha256')
        .update(match[1] ?? '')
        .digest('base64');
      return `'sha256-${digest}'`;
    });
    expect(inline).toHaveLength(1);

    const scriptSrc = /script-src ([^;]+);/.exec(headers)?.[1] ?? '';
    const allowedHashes = scriptSrc.split(' ').filter((source) => source.startsWith("'sha256-"));
    // If this fails after editing the theme script, update the hash in the nginx snippet.
    expect(allowedHashes).toEqual(inline);
    expect(scriptSrc).not.toContain('unsafe-inline');
  });
});
