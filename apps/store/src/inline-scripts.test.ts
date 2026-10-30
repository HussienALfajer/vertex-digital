import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * ADR 0015: the store's CSP allows inline scripts so its pages stay cached, which holds only while
 * every inline script or style is a constant written in this repository, never data from the API
 * or a customer (audit A10-63). A new `dangerouslySetInnerHTML` must be one of these, by name.
 */

const ALLOWED = new Set([
  'THEME_SCRIPT',
  'REGISTRATION_SCRIPT',
  'SESSION_HINT_SCRIPT',
  'DISMISSED_SCRIPT',
  'A4_RULES[orientation]',
  'PAGE_RULES[paper]',
]);

const root = new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [path] : [];
  });
}

describe('inline scripts and styles (ADR 0015)', () => {
  it('are named constants of this repository, never values from outside', () => {
    const found = sources(root).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}/g,
        ),
      ].map(([, value]) => ({ file: relative(root, file).replaceAll('\\', '/'), value })),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter(({ value }) => !ALLOWED.has(value ?? ''))).toEqual([]);
  });
});
