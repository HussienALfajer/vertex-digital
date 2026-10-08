import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newId } from '../id.js';
import {
  credentialHints,
  decryptCredentials,
  encryptCredentials,
  supplierKey,
} from './credentials.js';

/* Supplier credentials at rest (S07 rule SP2): AES-256-GCM bound to the supplier. */

const key = randomBytes(32);
const values = { apiKey: 'key-id.secret-value-a1b2', webhookSecret: 'whsec-c3d4' };

describe('supplier credentials', () => {
  it('round-trip with the key and the supplier', () => {
    const supplierId = newId();
    const sealed = encryptCredentials(key, supplierId, values);
    expect(sealed.includes(Buffer.from('secret-value'))).toBe(false);
    expect(decryptCredentials(key, supplierId, sealed)).toEqual(values);
  });

  it('use a new IV each time', () => {
    const supplierId = newId();
    const a = encryptCredentials(key, supplierId, values);
    const b = encryptCredentials(key, supplierId, values);
    expect(a.equals(b)).toBe(false);
  });

  it('refuse a ciphertext moved to another supplier, a wrong key or changed bytes', () => {
    const supplierId = newId();
    const sealed = encryptCredentials(key, supplierId, values);
    expect(() => decryptCredentials(key, newId(), sealed)).toThrow();
    expect(() => decryptCredentials(randomBytes(32), supplierId, sealed)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) as number) ^ 1;
    expect(() => decryptCredentials(key, supplierId, tampered)).toThrow();
    const otherVersion = Buffer.from(sealed);
    otherVersion[0] = 2;
    expect(() => decryptCredentials(key, supplierId, otherVersion)).toThrow(/key version/);
  });

  it('read the key from 32 bytes of base64 only', () => {
    expect(supplierKey(key.toString('base64')).equals(key)).toBe(true);
    expect(() => supplierKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('hint the last 4 characters of each field, and nothing of a short one', () => {
    expect(credentialHints(values)).toEqual({ apiKey: 'a1b2', webhookSecret: '' });
    expect(credentialHints({ apiKey: 'abcdefghi-a1b2' })).toEqual({ apiKey: 'a1b2' });
  });
});
