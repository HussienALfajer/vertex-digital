import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathUnderRoot } from '../src/jobs/telegram/deposit-card.job.js';

const posixRoot = '/srv/files';
const winRoot = win32.join('D:', 'data', 'files');

describe('pathUnderRoot', () => {
  it('accepts a key under a posix root', () => {
    expect(pathUnderRoot(posixRoot, 'receipts/ab/cd.webp', posix)).toBe(
      '/srv/files/receipts/ab/cd.webp',
    );
  });

  it('accepts a key under a Windows root (backslash separators)', () => {
    const full = pathUnderRoot(winRoot, 'receipts/ab/cd.webp', win32);
    expect(full).toBe(win32.join(winRoot, 'receipts', 'ab', 'cd.webp'));
    expect(full).toContain('\\');
  });

  it.each([
    ['posix', posix, posixRoot],
    ['win32', win32, winRoot],
  ] as const)('refuses a key that leaves the %s root', (_, paths, root) => {
    for (const key of ['../secret', 'a/../../secret', '../files-other/x', '']) {
      expect(() => pathUnderRoot(root, key, paths)).toThrow('A file key left the files root');
    }
  });

  it('refuses an absolute key elsewhere on the disk', () => {
    expect(() => pathUnderRoot(posixRoot, '/etc/passwd', posix)).toThrow();
    expect(() => pathUnderRoot(winRoot, win32.join('C:', 'Windows', 'x'), win32)).toThrow();
  });
});
