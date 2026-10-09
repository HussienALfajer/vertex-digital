import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newId } from '../id.js';
import { decryptSecret, encryptSecret, orderCodesKey } from './secrets.js';

/* Order codes and webhook bodies at rest (S08 rule C1): AES-256-GCM bound to their row. */

const key = randomBytes(32);
const code = 'ABCD-EFGH-IJKL-1234';

describe('order secrets', () => {
  it('round-trip with the key and the row, never in clear', () => {
    const rowId = newId();
    const sealed = encryptSecret(key, rowId, code);
    expect(sealed.includes(Buffer.from('EFGH'))).toBe(false);
    expect(decryptSecret(key, rowId, sealed)).toBe(code);
    expect(encryptSecret(key, rowId, code).equals(sealed)).toBe(false);
  });

  it('refuse a ciphertext moved to another row, a wrong key, changed bytes or version', () => {
    const rowId = newId();
    const sealed = encryptSecret(key, rowId, code);
    expect(() => decryptSecret(key, newId(), sealed)).toThrow();
    expect(() => decryptSecret(randomBytes(32), rowId, sealed)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) as number) ^ 1;
    expect(() => decryptSecret(key, rowId, tampered)).toThrow();
    const otherVersion = Buffer.from(sealed);
    otherVersion[0] = 2;
    expect(() => decryptSecret(key, rowId, otherVersion)).toThrow(/key version/);
  });

  it('read the key from 32 bytes of base64 only', () => {
    expect(orderCodesKey(key.toString('base64')).equals(key)).toBe(true);
    expect(() => orderCodesKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
