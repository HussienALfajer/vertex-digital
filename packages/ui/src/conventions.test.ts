import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Guards for AGENTS.md conventions and the patterns to avoid in brand/identity.md §9, applied to
 * every UI source file in the design system, the store and the admin panel.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceDirs = ['packages/ui/src', 'apps/store/src', 'apps/admin/src'];

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(tsx?|css)$/.test(entry.name))
    .filter((entry) => !/\.(test|gen)\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const files = sourceDirs.flatMap(sourceFiles);

/** Lines matching the pattern, as `path:line: text` with forward slashes. */
function violations(pattern: RegExp): string[] {
  return files.flatMap((file) => {
    const path = relative(root, file).split(sep).join('/');
    return readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : []));
  });
}

/** A utility class: preceded by a quote, space, backtick or variant colon; followed by a boundary. */
const utility = (body: string) =>
  new RegExp(String.raw`(?<=["'${'`'}\s:])-?(?:${body})(?=[\s"'${'`'}]|$)`);

const value = String.raw`[\w./[\]-]+`;

describe('UI conventions', () => {
  it('finds the sources it checks in every tree', () => {
    for (const dir of sourceDirs) {
      const inDir = files.filter((file) =>
        relative(root, file).split(sep).join('/').startsWith(dir),
      );
      expect(inDir.length, dir).toBeGreaterThan(0);
    }
  });

  it('uses logical directions only (RTL first)', () => {
    const physical = utility(
      [
        `(?:m|p|scroll-m|scroll-p)[lr]-${value}`,
        `(?:left|right)-${value}`,
        'text-(?:left|right)',
        `(?:border|rounded)-[lr](?:-${value})?`,
        `rounded-[tb][lr](?:-${value})?`,
        'float-(?:left|right)',
      ].join('|'),
    );
    expect(violations(physical)).toEqual([]);
  });

  it('avoids the patterns listed in brand/identity.md §9', () => {
    const banned = utility(
      [
        `bg-(?:gradient|linear|radial|conic)-${value}`,
        `(?:from|via)-${value}`,
        'backdrop-blur(?:-[\\w-]+)?',
        'italic',
        `tracking-${value}`,
        'font-mono',
        'uppercase',
      ].join('|'),
    );
    expect(violations(banned)).toEqual([]);
  });

  it('keeps colors in tokens: no hex, rgb or oklch values outside the theme', () => {
    const offenders = violations(/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/).filter(
      (line) => !line.startsWith('packages/ui/src/styles/theme.css:'),
    );
    expect(offenders).toEqual([]);
  });
});
