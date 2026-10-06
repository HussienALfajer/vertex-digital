import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readConfig(name: string): { extends?: string; compilerOptions?: Record<string, unknown> } {
  return JSON.parse(readFileSync(new URL(`../tsconfig/${name}`, import.meta.url), 'utf8'));
}

describe('shared tsconfig', () => {
  it('base enables strict mode and unchecked index access', () => {
    const { compilerOptions } = readConfig('base.json');
    expect(compilerOptions?.strict).toBe(true);
    expect(compilerOptions?.noUncheckedIndexedAccess).toBe(true);
  });

  it('node extends base and resolves modules as Node does', () => {
    const config = readConfig('node.json');
    expect(config.extends).toBe('./base.json');
    expect(config.compilerOptions?.module).toBe('NodeNext');
  });
});
